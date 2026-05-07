// @ts-ignore
import composerize from "composerize";
import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { R } from "redbean-node";
import { loginRateLimiter, twoFaRateLimiter } from "../rate-limiter";
import { generatePasswordHash, needRehashPassword, shake256, SHAKE256_LENGTH, verifyPassword } from "../password-hash";
import { User } from "../models/user";
import {
    callbackError,
    checkLogin,
    DockgeSocket,
    doubleCheckPassword,
    JWTDecoded,
    ValidationError
} from "../util-server";
import { passwordStrength } from "check-password-strength";
import jwt from "jsonwebtoken";
import { Settings } from "../settings";
import fs, { promises as fsAsync } from "fs";
import path from "path";
import {
    generateTOTPSecret,
    verifyTOTP,
    encryptSecret,
    decryptSecret,
    generateRecoveryCodes,
    hashRecoveryCodes,
    isAccountLocked,
    incrementFailedAttempts,
    resetFailedAttempts,
    consumeRecoveryCode,
    getRecoveryCodesCount,
    getMaxFailedAttempts,
    getLockoutDurationMinutes,
} from "../two-factor-auth";

export class MainSocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {

        // ***************************
        // Public Socket API
        // ***************************

        // Setup
        socket.on("setup", async (username, password, callback) => {
            try {
                if (passwordStrength(password).value === "Too weak") {
                    throw new Error("Password is too weak. It should contain alphabetic and numeric characters. It must be at least 6 characters in length.");
                }

                if ((await R.knex("user").count("id as count").first()).count !== 0) {
                    throw new Error("Dockge has been initialized. If you want to run setup again, please delete the database.");
                }

                const user = R.dispense("user");
                user.username = username;
                user.password = generatePasswordHash(password);
                await R.store(user);

                server.needSetup = false;

                callback({
                    ok: true,
                    msg: "successAdded",
                    msgi18n: true,
                });

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        // Login by token
        socket.on("loginByToken", async (token, callback) => {
            const clientIP = await server.getClientIP(socket);

            log.info("auth", `Login by token. IP=${clientIP}`);

            try {
                const decoded = jwt.verify(token, server.jwtSecret) as JWTDecoded;

                log.info("auth", "Username from JWT: " + decoded.username);

                const user = await R.findOne("user", " username = ? AND active = 1 ", [
                    decoded.username,
                ]) as User;

                if (user) {
                    if (decoded.h !== shake256(user.password, SHAKE256_LENGTH)) {
                        throw new Error("The token is invalid due to password change or old token");
                    }

                    log.debug("auth", "afterLogin");
                    await server.afterLogin(socket, user);
                    log.debug("auth", "afterLogin ok");

                    log.info("auth", `Successfully logged in user ${decoded.username}. IP=${clientIP}`);

                    callback({
                        ok: true,
                    });
                } else {

                    log.info("auth", `Inactive or deleted user ${decoded.username}. IP=${clientIP}`);

                    callback({
                        ok: false,
                        msg: "authUserInactiveOrDeleted",
                        msgi18n: true,
                    });
                }
            } catch (error) {
                if (!(error instanceof Error)) {
                    console.error("Unknown error:", error);
                    return;
                }
                log.error("auth", `Invalid token. IP=${clientIP}`);
                if (error.message) {
                    log.error("auth", error.message + ` IP=${clientIP}`);
                }
                callback({
                    ok: false,
                    msg: "authInvalidToken",
                    msgi18n: true,
                });
            }

        });

        // Login
        socket.on("login", async (data, callback) => {
            const clientIP = await server.getClientIP(socket);

            log.info("auth", `Login by username + password. IP=${clientIP}`);

            if (typeof callback !== "function") {
                return;
            }

            if (!data) {
                return;
            }

            if (!await loginRateLimiter.pass(callback)) {
                log.info("auth", `Too many failed requests for user ${data.username}. IP=${clientIP}`);
                return;
            }

            const user = await this.login(data.username, data.password);

            if (user) {
                if (user.twofa_status === 0) {
                    server.afterLogin(socket, user);

                    log.info("auth", `Successfully logged in user ${data.username}. IP=${clientIP}`);

                    callback({
                        ok: true,
                        token: User.createJWT(user, server.jwtSecret),
                    });
                    return;
                }

                if (user.twofa_status === 1) {
                    if (isAccountLocked(user.twofa_locked_until)) {
                        log.warn("auth", `Account locked due to too many 2FA failures for user ${data.username}. IP=${clientIP}`);
                        callback({
                            ok: false,
                            msg: "2faAccountLocked",
                            msgi18n: true,
                            lockoutMinutes: getLockoutDurationMinutes(),
                        });
                        return;
                    }

                    if (!data.token && !data.recoveryCode) {
                        log.info("auth", `2FA token required for user ${data.username}. IP=${clientIP}`);

                        socket.pending2FAUserID = user.id;

                        callback({
                            tokenRequired: true,
                        });
                        return;
                    }

                    if (!await twoFaRateLimiter.pass(callback)) {
                        log.info("auth", `Too many 2FA attempts for user ${data.username}. IP=${clientIP}`);
                        return;
                    }

                    if (data.recoveryCode) {
                        const used = await consumeRecoveryCode(user.id, data.recoveryCode);
                        if (used) {
                            await resetFailedAttempts(user.id);
                            await R.exec("UPDATE `user` SET twofa_last_token = ? WHERE id = ? ", [
                                "recovery-" + Date.now(),
                                user.id,
                            ]);
                            server.afterLogin(socket, user);
                            log.info("auth", `Successfully logged in user ${data.username} via recovery code. IP=${clientIP}`);
                            callback({
                                ok: true,
                                token: User.createJWT(user, server.jwtSecret),
                                recoveryCodeUsed: true,
                            });
                        } else {
                            const attempts = await incrementFailedAttempts(user.id);
                            log.warn("auth", `Invalid recovery code for user ${data.username} (attempt ${attempts}). IP=${clientIP}`);
                            callback({
                                ok: false,
                                msg: "2faInvalidRecoveryCode",
                                msgi18n: true,
                                attemptsRemaining: getMaxFailedAttempts() - attempts,
                            });
                        }
                        return;
                    }

                    if (data.token) {
                        let secret: string;
                        try {
                            secret = decryptSecret(user.twofa_secret, server.jwtSecret);
                        } catch (e) {
                            log.error("auth", `Failed to decrypt 2FA secret for user ${data.username}`);
                            callback({
                                ok: false,
                                msg: "2faSecretError",
                                msgi18n: true,
                            });
                            return;
                        }

                        const isValid = verifyTOTP(data.token, secret);
                        if (isValid && user.twofa_last_token !== data.token) {
                            await resetFailedAttempts(user.id);
                            await R.exec("UPDATE `user` SET twofa_last_token = ? WHERE id = ? ", [
                                data.token,
                                user.id,
                            ]);
                            server.afterLogin(socket, user);
                            log.info("auth", `Successfully logged in user ${data.username}. IP=${clientIP}`);
                            callback({
                                ok: true,
                                token: User.createJWT(user, server.jwtSecret),
                            });
                        } else if (user.twofa_last_token === data.token) {
                            log.warn("auth", `Replayed 2FA token for user ${data.username}. IP=${clientIP}`);
                            callback({
                                ok: false,
                                msg: "2faTokenReplayed",
                                msgi18n: true,
                            });
                        } else {
                            const attempts = await incrementFailedAttempts(user.id);
                            log.warn("auth", `Invalid 2FA token for user ${data.username} (attempt ${attempts}). IP=${clientIP}`);
                            callback({
                                ok: false,
                                msg: "authInvalidToken",
                                msgi18n: true,
                                attemptsRemaining: getMaxFailedAttempts() - attempts,
                            });
                        }
                    }
                }
            } else {

                log.warn("auth", `Incorrect username or password for user ${data.username}. IP=${clientIP}`);

                callback({
                    ok: false,
                    msg: "authIncorrectCreds",
                    msgi18n: true,
                });
            }

        });

        // Change Password
        socket.on("changePassword", async (password, callback) => {
            try {
                checkLogin(socket);

                if (! password.newPassword) {
                    throw new Error("Invalid new password");
                }

                if (passwordStrength(password.newPassword).value === "Too weak") {
                    throw new Error("Password is too weak. It should contain alphabetic and numeric characters. It must be at least 6 characters in length.");
                }

                let user = await doubleCheckPassword(socket, password.currentPassword);
                await user.resetPassword(password.newPassword);

                server.disconnectAllSocketClients(user.id, socket.id);

                callback({
                    ok: true,
                    msg: "Password has been updated successfully.",
                });

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        socket.on("getSettings", async (callback) => {
            try {
                checkLogin(socket);
                const data = await Settings.getSettings("general");

                if (fs.existsSync(path.join(server.stacksDir, "global.env"))) {
                    data.globalENV = fs.readFileSync(path.join(server.stacksDir, "global.env"), "utf-8");
                } else {
                    data.globalENV = "# VARIABLE=value #comment";
                }

                callback({
                    ok: true,
                    data: data,
                });

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        socket.on("setSettings", async (data, currentPassword, callback) => {
            try {
                checkLogin(socket);

                const currentDisabledAuth = await Settings.get("disableAuth");
                if (!currentDisabledAuth && data.disableAuth) {
                    await doubleCheckPassword(socket, currentPassword);
                }
                if (data.globalENV && data.globalENV != "# VARIABLE=value #comment") {
                    await fsAsync.writeFile(path.join(server.stacksDir, "global.env"), data.globalENV);
                } else {
                    await fsAsync.rm(path.join(server.stacksDir, "global.env"), {
                        recursive: true,
                        force: true
                    });
                }
                delete data.globalENV;

                await Settings.setSettings("general", data);

                callback({
                    ok: true,
                    msg: "Saved"
                });

                server.sendInfo(socket);

            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        // Disconnect all other socket clients of the user
        socket.on("disconnectOtherSocketClients", async () => {
            try {
                checkLogin(socket);
                server.disconnectAllSocketClients(socket.userID, socket.id);
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("disconnectOtherSocketClients", e.message);
                }
            }
        });

        // composerize
        socket.on("composerize", async (dockerRunCommand : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(dockerRunCommand) !== "string") {
                    throw new ValidationError("dockerRunCommand must be a string");
                }

                let composeTemplate = composerize(dockerRunCommand, "", "latest");

                composeTemplate = composeTemplate.split("\n").slice(1).join("\n");

                callback({
                    ok: true,
                    composeTemplate,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // ***************************
        // 2FA Management Socket API
        // ***************************

        socket.on("twoFAStatus", async (callback) => {
            try {
                checkLogin(socket);
                const user = await R.findOne("user", " id = ? ", [socket.userID]) as User;
                if (!user) {
                    throw new Error("User not found");
                }
                callback({
                    ok: true,
                    status: user.twofa_status === 1,
                    recoveryCodesCount: getRecoveryCodesCount(user.twofa_recovery_codes),
                });
            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        socket.on("prepare2FA", async (currentPassword, callback) => {
            try {
                checkLogin(socket);

                const user = await doubleCheckPassword(socket, currentPassword);

                if (user.twofa_status === 1) {
                    throw new Error("2FA is already enabled");
                }

                const { secret, uri } = generateTOTPSecret(user.username);
                const encryptedSecret = encryptSecret(secret, server.jwtSecret);

                await R.exec("UPDATE `user` SET twofa_secret = ? WHERE id = ? ", [
                    encryptedSecret,
                    user.id,
                ]);

                log.info("2fa", `Prepared 2FA for user ${user.username}`);

                callback({
                    ok: true,
                    uri: uri,
                    secret: secret,
                });
            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        socket.on("verifyToken", async (token, currentPassword, callback) => {
            try {
                checkLogin(socket);

                const user = await doubleCheckPassword(socket, currentPassword);

                let secret: string;
                try {
                    secret = decryptSecret(user.twofa_secret, server.jwtSecret);
                } catch (e) {
                    throw new Error("Failed to decrypt 2FA secret. Please try preparing 2FA again.");
                }

                const valid = verifyTOTP(token, secret);
                callback({
                    ok: true,
                    valid: valid,
                });
            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        socket.on("save2FA", async (currentPassword, callback) => {
            try {
                checkLogin(socket);

                const user = await doubleCheckPassword(socket, currentPassword);

                if (!user.twofa_secret) {
                    throw new Error("2FA secret not found. Please prepare 2FA first.");
                }

                const recoveryCodes = generateRecoveryCodes();
                const hashedCodes = hashRecoveryCodes(recoveryCodes);

                await R.exec("UPDATE `user` SET twofa_status = 1, twofa_method = ?, twofa_recovery_codes = ?, twofa_last_token = NULL, twofa_failed_attempts = 0, twofa_locked_until = NULL, twofa_secret_set_at = ? WHERE id = ? ", [
                    "totp",
                    JSON.stringify(hashedCodes),
                    new Date().toISOString(),
                    user.id,
                ]);

                log.info("2fa", `Enabled TOTP 2FA for user ${user.username}`);

                callback({
                    ok: true,
                    msg: "2faEnabled",
                    msgi18n: true,
                    recoveryCodes: recoveryCodes,
                });
            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        socket.on("disable2FA", async (currentPassword, callback) => {
            try {
                checkLogin(socket);

                const user = await doubleCheckPassword(socket, currentPassword);

                await R.exec("UPDATE `user` SET twofa_status = 0, twofa_secret = NULL, twofa_method = 'totp', twofa_recovery_codes = NULL, twofa_last_token = NULL, twofa_failed_attempts = 0, twofa_locked_until = NULL, twofa_secret_set_at = NULL WHERE id = ? ", [
                    user.id,
                ]);

                log.info("2fa", `Disabled 2FA for user ${user.username}`);

                callback({
                    ok: true,
                    msg: "2faDisabled",
                    msgi18n: true,
                });
            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });

        socket.on("generateRecoveryCodes", async (currentPassword, callback) => {
            try {
                checkLogin(socket);

                const user = await doubleCheckPassword(socket, currentPassword);

                if (user.twofa_status !== 1) {
                    throw new Error("2FA is not enabled");
                }

                const recoveryCodes = generateRecoveryCodes();
                const hashedCodes = hashRecoveryCodes(recoveryCodes);

                await R.exec("UPDATE `user` SET twofa_recovery_codes = ? WHERE id = ? ", [
                    JSON.stringify(hashedCodes),
                    user.id,
                ]);

                log.info("2fa", `Regenerated recovery codes for user ${user.username}`);

                callback({
                    ok: true,
                    recoveryCodes: recoveryCodes,
                });
            } catch (e) {
                if (e instanceof Error) {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                }
            }
        });
    }

    async login(username : string, password : string) : Promise<User | null> {
        if (typeof username !== "string" || typeof password !== "string") {
            return null;
        }

        const user = await R.findOne("user", " username = ? AND active = 1 ", [
            username,
        ]) as User;

        if (user && verifyPassword(password, user.password)) {
            if (needRehashPassword(user.password)) {
                await R.exec("UPDATE `user` SET password = ? WHERE id = ? ", [
                    generatePasswordHash(password),
                    user.id,
                ]);
            }
            return user;
        }

        return null;
    }
}
