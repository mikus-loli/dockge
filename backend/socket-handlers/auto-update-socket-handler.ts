import { SocketHandler } from "../socket-handler";
import { DockgeServer } from "../dockge-server";
import { checkLogin, callbackError, callbackResult, DockgeSocket } from "../util-server";
import { AutoUpdater } from "../auto-updater";

export class AutoUpdateSocketHandler extends SocketHandler {
    create(socket: DockgeSocket, server: DockgeServer) {
        const autoUpdater = server.autoUpdater;

        socket.on("autoUpdateGetStatus", async (callback) => {
            try {
                checkLogin(socket);
                const status = await autoUpdater.getUpdateStatus();
                callbackResult({
                    ok: true,
                    data: status,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("autoUpdateSaveSettings", async (settings, callback) => {
            try {
                checkLogin(socket);
                await autoUpdater.saveUpdateSettings(settings);
                callbackResult({
                    ok: true,
                    msg: "autoUpdateSettingsSaved",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("autoUpdateCheckNow", async (callback) => {
            try {
                checkLogin(socket);
                if (autoUpdater.isChecking) {
                    callbackResult({
                        ok: false,
                        msg: "autoUpdateCheckInProgress",
                        msgi18n: true,
                    }, callback);
                    return;
                }

                await autoUpdater.checkAllStacks();
                callbackResult({
                    ok: true,
                    msg: "autoUpdateCheckCompleted",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("autoUpdateCheckStack", async (stackName, callback) => {
            try {
                checkLogin(socket);

                if (typeof stackName !== "string") {
                    throw new Error("Stack name must be a string");
                }

                const results = await autoUpdater.checkSingleStack(stackName);
                callbackResult({
                    ok: true,
                    results,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("autoUpdateExecute", async (stackName, callback) => {
            try {
                checkLogin(socket);

                if (typeof stackName !== "string") {
                    throw new Error("Stack name must be a string");
                }

                if (autoUpdater.isUpdating) {
                    callbackResult({
                        ok: false,
                        msg: "autoUpdateInProgress",
                        msgi18n: true,
                    }, callback);
                    return;
                }

                const success = await autoUpdater.executeUpdate(stackName);
                callbackResult({
                    ok: success,
                    msg: success ? "autoUpdateExecuted" : "autoUpdateFailed",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("autoUpdateRollback", async (stackName, callback) => {
            try {
                checkLogin(socket);

                if (typeof stackName !== "string") {
                    throw new Error("Stack name must be a string");
                }

                const success = await autoUpdater.executeRollback(stackName);
                callbackResult({
                    ok: success,
                    msg: success ? "autoUpdateRollbackSuccess" : "autoUpdateRollbackFailed",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("autoUpdateGetLogs", async (stackName, limit, callback) => {
            try {
                checkLogin(socket);

                const logs = await autoUpdater.getUpdateLogs(
                    stackName || undefined,
                    limit || 100
                );
                callbackResult({
                    ok: true,
                    logs,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("autoUpdateClearLogs", async (beforeDays, callback) => {
            try {
                checkLogin(socket);
                await autoUpdater.clearUpdateLogs(beforeDays || 30);
                callbackResult({
                    ok: true,
                    msg: "autoUpdateLogsCleared",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }
}
