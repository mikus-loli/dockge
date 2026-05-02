import * as OTPAuth from "otpauth";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { R } from "redbean-node";
import { log } from "./log";
import { shake256 } from "./password-hash";

const TOTP_ISSUER = "Dockge";
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 8;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;
const VERIFICATION_CODE_EXPIRY_MINUTES = 5;
const VERIFICATION_CODE_LENGTH = 6;

let encryptionKey: Buffer | null = null;

function getEncryptionKey(jwtSecret: string): Buffer {
    if (!encryptionKey) {
        encryptionKey = scryptSync(jwtSecret, "dockge-2fa-salt", 32);
    }
    return encryptionKey;
}

export function resetEncryptionKey(): void {
    encryptionKey = null;
}

export function encryptSecret(secret: string, jwtSecret: string): string {
    const key = getEncryptionKey(jwtSecret);
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    let encrypted = cipher.update(secret, "utf8", "hex");
    encrypted += cipher.final("hex");
    return iv.toString("hex") + ":" + encrypted;
}

export function decryptSecret(encryptedSecret: string, jwtSecret: string): string {
    const key = getEncryptionKey(jwtSecret);
    const parts = encryptedSecret.split(":");
    if (parts.length !== 2) {
        throw new Error("Invalid encrypted secret format");
    }
    const iv = Buffer.from(parts[0], "hex");
    const encrypted = parts[1];
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}

export function generateTOTPSecret(username: string): { secret: string; uri: string } {
    const secret = OTPAuth.Secret.fromHex(randomBytes(20).toString("hex"));
    const totp = new OTPAuth.TOTP({
        issuer: TOTP_ISSUER,
        label: username,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: secret,
    });
    return {
        secret: secret.base32,
        uri: totp.toString(),
    };
}

export function verifyTOTP(token: string, secretBase32: string): boolean {
    try {
        const totp = new OTPAuth.TOTP({
            issuer: TOTP_ISSUER,
            algorithm: "SHA1",
            digits: 6,
            period: 30,
            secret: OTPAuth.Secret.fromBase32(secretBase32),
        });
        const delta = totp.validate({ token,
            window: 1 });
        return delta !== null;
    } catch (e) {
        log.error("2fa", "TOTP verification error: " + (e instanceof Error ? e.message : String(e)));
        return false;
    }
}

export function generateRecoveryCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        const bytes = randomBytes(RECOVERY_CODE_LENGTH);
        let code = "";
        for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) {
            code += bytes[j].toString(16).padStart(2, "0").charAt(j % 2);
        }
        code = code.toUpperCase();
        codes.push(code.slice(0, 4) + "-" + code.slice(4));
    }
    return codes;
}

export function hashRecoveryCode(code: string): string {
    return shake256(code, 8);
}

export function hashRecoveryCodes(codes: string[]): string[] {
    return codes.map(code => hashRecoveryCode(code));
}

export function verifyRecoveryCode(code: string, hashedCodes: string[]): boolean {
    const hashedInput = hashRecoveryCode(code);
    return hashedCodes.includes(hashedInput);
}

export function generateVerificationCode(): string {
    const bytes = randomBytes(VERIFICATION_CODE_LENGTH);
    let code = "";
    for (let i = 0; i < VERIFICATION_CODE_LENGTH; i++) {
        code += (bytes[i] % 10).toString();
    }
    return code;
}

export function isVerificationCodeExpired(expiresAt: Date | string | null): boolean {
    if (!expiresAt) {
        return true;
    }
    const expiry = new Date(expiresAt);
    return new Date() > expiry;
}

export function getVerificationCodeExpiry(): Date {
    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + VERIFICATION_CODE_EXPIRY_MINUTES);
    return expiry;
}

export function getMaxFailedAttempts(): number {
    return MAX_FAILED_ATTEMPTS;
}

export function getLockoutDurationMinutes(): number {
    return LOCKOUT_DURATION_MINUTES;
}

export function isAccountLocked(lockedUntil: Date | string | null): boolean {
    if (!lockedUntil) {
        return false;
    }
    const lockTime = new Date(lockedUntil);
    return new Date() < lockTime;
}

export function getLockoutExpiry(): Date {
    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + LOCKOUT_DURATION_MINUTES);
    return expiry;
}

export async function incrementFailedAttempts(userId: number): Promise<number> {
    await R.exec(
        "UPDATE `user` SET twofa_failed_attempts = twofa_failed_attempts + 1 WHERE id = ?",
        [ userId ]
    );
    const user = await R.findOne("user", " id = ? ", [ userId ]);
    const attempts = user?.twofa_failed_attempts ?? 0;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
        const lockedUntil = getLockoutExpiry();
        await R.exec(
            "UPDATE `user` SET twofa_locked_until = ? WHERE id = ?",
            [ lockedUntil.toISOString(), userId ]
        );
    }
    return attempts;
}

export async function resetFailedAttempts(userId: number): Promise<void> {
    await R.exec(
        "UPDATE `user` SET twofa_failed_attempts = 0, twofa_locked_until = NULL WHERE id = ?",
        [ userId ]
    );
}

export async function consumeRecoveryCode(userId: number, code: string): Promise<boolean> {
    const user = await R.findOne("user", " id = ? ", [ userId ]);
    if (!user || !user.twofa_recovery_codes) {
        return false;
    }
    const hashedCodes: string[] = JSON.parse(user.twofa_recovery_codes);
    const hashedInput = hashRecoveryCode(code);
    const index = hashedCodes.indexOf(hashedInput);
    if (index === -1) {
        return false;
    }
    hashedCodes.splice(index, 1);
    await R.exec(
        "UPDATE `user` SET twofa_recovery_codes = ? WHERE id = ?",
        [ JSON.stringify(hashedCodes), userId ]
    );
    return true;
}

export function getRecoveryCodesCount(hashedCodesJson: string | null): number {
    if (!hashedCodesJson) {
        return 0;
    }
    try {
        const codes: string[] = JSON.parse(hashedCodesJson);
        return codes.length;
    } catch {
        return 0;
    }
}
