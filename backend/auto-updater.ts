import { log } from "./log";
import { Settings } from "./settings";
import { DockgeServer } from "./dockge-server";
import childProcess from "child_process";
import compareVersions from "compare-versions";
import packageJSON from "../package.json";
import { R } from "redbean-node";
import notificationManager from "./notification-manager";

const CHECK_URL = "https://dockge.kuma.pet/version";
const AUTO_UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_LOG_ENTRIES = 500;

interface VersionInfo {
    slow?: string;
    beta?: string;
}

export interface AutoUpdateStatus {
    enabled: boolean;
    updateWindow?: string;
    lastCheck?: number;
    lastAttempt?: number;
    lastError?: string;
    latestVersion?: string;
    currentVersion: string;
    updateAvailable: boolean;
    isUpdating: boolean;
    rollbackAvailable: boolean;
    retryCount: number;
    maxRetries: number;
}

export interface UpdateLogEntry {
    id?: number;
    image_name: string;
    target_type: "dockge" | "stack";
    target_name?: string;
    old_version?: string;
    new_version?: string;
    status: "started" | "success" | "failed" | "rolled_back";
    error_message?: string;
    duration_ms?: number;
    rollback_image?: string;
    created_at?: string;
}

class AutoUpdater {
    private server: DockgeServer | null = null;
    private interval?: NodeJS.Timeout;
    private isUpdating = false;
    private currentVersion = packageJSON.version;
    private latestVersion?: string;
    private retryCount = 0;
    private rollbackImage?: string;

    async init(server: DockgeServer) {
        this.server = server;
        await notificationManager.init(server);
        await this.checkForUpdate();
        this.startInterval();
    }

    startInterval() {
        this.interval = setInterval(async () => {
            const autoUpdate = await Settings.get("autoUpdate");
            if (autoUpdate) {
                await this.checkAndAutoUpdate();
            } else {
                await this.checkForUpdate();
            }
        }, AUTO_UPDATE_CHECK_INTERVAL_MS);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
        }
    }

    async checkForUpdate(): Promise<VersionInfo | null> {
        try {
            log.debug("auto-updater", "Checking for updates...");
            const res = await fetch(CHECK_URL);
            const data: VersionInfo = await res.json();

            if (process.env.TEST_CHECK_VERSION === "1") {
                data.slow = "1000.0.0";
            }

            const checkBeta = await Settings.get("checkBeta");
            const checkUpdate = await Settings.get("checkUpdate");

            if (!checkUpdate) {
                return null;
            }

            const prevVersion = this.latestVersion;

            if (checkBeta && data.beta) {
                if (compareVersions.compare(data.beta, this.currentVersion, ">")) {
                    this.latestVersion = data.beta;
                } else if (data.slow && compareVersions.compare(data.slow, this.currentVersion, ">")) {
                    this.latestVersion = data.slow;
                }
            } else if (data.slow && compareVersions.compare(data.slow, this.currentVersion, ">")) {
                this.latestVersion = data.slow;
            } else {
                this.latestVersion = undefined;
            }

            await Settings.set("lastUpdateCheck", Date.now());
            await Settings.set("lastError", "");

            if (this.latestVersion && this.latestVersion !== prevVersion) {
                log.info("auto-updater", `New version available: ${this.latestVersion}`);
                await notificationManager.send({
                    event: "update_available",
                    title: "New version available",
                    message: `Dockge ${this.latestVersion} is available (current: ${this.currentVersion})`,
                    imageName: this.getDockerImageName() || "louislam/dockge",
                    targetType: "dockge",
                    targetName: "dockge",
                    oldVersion: this.currentVersion,
                    newVersion: this.latestVersion,
                    timestamp: Date.now(),
                });
            }

            return data;
        } catch (e) {
            log.error("auto-updater", "Failed to check for updates: " + e);
            await Settings.set("lastError", String(e));
            return null;
        }
    }

    async checkAndAutoUpdate(): Promise<boolean> {
        await this.checkForUpdate();

        if (!this.latestVersion) {
            return false;
        }

        const updateWindow = await Settings.get("autoUpdateWindow");
        if (updateWindow && !this.isWithinUpdateWindow(updateWindow)) {
            log.debug("auto-updater", "Outside update window, skipping auto-update");
            return false;
        }

        log.info("auto-updater", "Starting auto-update...");
        return this.performUpdate();
    }

    isWithinUpdateWindow(window: string): boolean {
        if (!window || window === "any") {
            return true;
        }

        const now = new Date();
        const currentHour = now.getHours();

        const parts = window.split("-");
        if (parts.length !== 2) {
            return true;
        }

        const start = parseInt(parts[0].trim(), 10);
        const end = parseInt(parts[1].trim(), 10);

        if (isNaN(start) || isNaN(end)) {
            return true;
        }

        if (start <= end) {
            return currentHour >= start && currentHour < end;
        } else {
            return currentHour >= start || currentHour < end;
        }
    }

    async performUpdate(): Promise<boolean> {
        if (this.isUpdating) {
            log.warn("auto-updater", "Update already in progress");
            return false;
        }

        this.isUpdating = true;
        const startTime = Date.now();
        let logId: number | undefined;

        try {
            await Settings.set("lastUpdateAttempt", Date.now());

            const imageName = this.getDockerImageName();
            if (!imageName) {
                throw new Error("Could not determine Docker image name");
            }

            logId = await this.writeLog({
                image_name: imageName,
                target_type: "dockge",
                target_name: "dockge",
                old_version: this.currentVersion,
                new_version: this.latestVersion,
                status: "started",
                rollback_image: this.rollbackImage,
            });

            await notificationManager.send({
                event: "update_started",
                title: "Update started",
                message: `Dockge is updating from ${this.currentVersion} to ${this.latestVersion}`,
                imageName,
                targetType: "dockge",
                targetName: "dockge",
                oldVersion: this.currentVersion,
                newVersion: this.latestVersion,
                timestamp: Date.now(),
            });

            await this.tagRollbackImage(imageName);

            log.info("auto-updater", `Pulling latest image: ${imageName}`);
            await this.execCommandWithRetry("docker", ["pull", imageName]);

            log.info("auto-updater", "Restarting container...");
            await this.restartSelf();

            const duration = Date.now() - startTime;
            this.retryCount = 0;

            if (logId) {
                await this.updateLog(logId, {
                    status: "success",
                    duration_ms: duration,
                });
            }

            log.info("auto-updater", `Update completed successfully in ${duration}ms`);
            await Settings.set("lastError", "");

            await notificationManager.send({
                event: "update_success",
                title: "Update completed",
                message: `Dockge has been updated to ${this.latestVersion}`,
                imageName,
                targetType: "dockge",
                targetName: "dockge",
                oldVersion: this.currentVersion,
                newVersion: this.latestVersion,
                timestamp: Date.now(),
            });

            return true;
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            const duration = Date.now() - startTime;
            log.error("auto-updater", "Update failed: " + errorMsg);
            await Settings.set("lastError", errorMsg);

            if (logId) {
                await this.updateLog(logId, {
                    status: "failed",
                    error_message: errorMsg,
                    duration_ms: duration,
                });
            }

            await notificationManager.send({
                event: "update_failed",
                title: "Update failed",
                message: `Failed to update Dockge: ${errorMsg}`,
                imageName: this.getDockerImageName() || "louislam/dockge",
                targetType: "dockge",
                targetName: "dockge",
                oldVersion: this.currentVersion,
                newVersion: this.latestVersion,
                error: errorMsg,
                timestamp: Date.now(),
            });

            if (this.retryCount < MAX_RETRY_ATTEMPTS) {
                this.retryCount++;
                log.info("auto-updater", `Retrying update in ${RETRY_DELAY_MS / 1000}s (attempt ${this.retryCount}/${MAX_RETRY_ATTEMPTS})`);
                setTimeout(() => {
                    this.isUpdating = false;
                    this.performUpdate();
                }, RETRY_DELAY_MS);
                return false;
            }

            return false;
        } finally {
            if (this.retryCount === 0) {
                this.isUpdating = false;
            }
        }
    }

    private async tagRollbackImage(imageName: string): Promise<void> {
        try {
            const currentImageId = await this.getImageId(imageName);
            if (currentImageId) {
                const rollbackTag = `${imageName.split(":")[0]}:rollback-${Date.now()}`;
                await this.execCommand("docker", ["tag", currentImageId, rollbackTag]);
                this.rollbackImage = rollbackTag;
                log.info("auto-updater", `Tagged rollback image: ${rollbackTag}`);
            }
        } catch (e) {
            log.warn("auto-updater", `Failed to tag rollback image: ${e}`);
        }
    }

    async rollback(): Promise<boolean> {
        if (!this.rollbackImage) {
            log.warn("auto-updater", "No rollback image available");
            return false;
        }

        const startTime = Date.now();
        let logId: number | undefined;

        try {
            const imageName = this.getDockerImageName();
            if (!imageName) {
                throw new Error("Could not determine Docker image name");
            }

            logId = await this.writeLog({
                image_name: imageName,
                target_type: "dockge",
                target_name: "dockge",
                old_version: this.latestVersion,
                new_version: this.currentVersion,
                status: "started",
            });

            log.info("auto-updater", `Rolling back to: ${this.rollbackImage}`);
            await this.execCommand("docker", ["tag", this.rollbackImage, imageName]);
            await this.restartSelf();

            const duration = Date.now() - startTime;

            if (logId) {
                await this.updateLog(logId, {
                    status: "rolled_back",
                    duration_ms: duration,
                });
            }

            log.info("auto-updater", "Rollback completed successfully");

            await notificationManager.send({
                event: "rollback_success",
                title: "Rollback completed",
                message: `Dockge has been rolled back to ${this.currentVersion}`,
                imageName,
                targetType: "dockge",
                targetName: "dockge",
                timestamp: Date.now(),
            });

            return true;
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            const duration = Date.now() - startTime;
            log.error("auto-updater", "Rollback failed: " + errorMsg);

            if (logId) {
                await this.updateLog(logId, {
                    status: "failed",
                    error_message: errorMsg,
                    duration_ms: duration,
                });
            }

            await notificationManager.send({
                event: "rollback_failed",
                title: "Rollback failed",
                message: `Failed to rollback Dockge: ${errorMsg}`,
                error: errorMsg,
                timestamp: Date.now(),
            });

            return false;
        }
    }

    getDockerImageName(): string | null {
        try {
            const hostname = process.env.HOSTNAME || process.env.HOST;
            if (!hostname) {
                const containerId = childProcess.execSync("cat /etc/hostname 2>/dev/null || hostname").toString().trim();
                if (containerId) {
                    const image = childProcess.execSync(`docker inspect --format='{{.Config.Image}}' ${containerId} 2>/dev/null || echo ""`).toString().trim();
                    if (image) {
                        return image;
                    }
                }
            } else {
                const image = childProcess.execSync(`docker inspect --format='{{.Config.Image}}' ${hostname} 2>/dev/null || echo ""`).toString().trim();
                if (image) {
                    return image;
                }
            }

            const envImage = process.env.DOCKGE_IMAGE || process.env.DOCKER_IMAGE;
            if (envImage) {
                return envImage;
            }

            return "louislam/dockge:latest";
        } catch (e) {
            log.warn("auto-updater", "Could not determine Docker image name, using default");
            return "louislam/dockge:latest";
        }
    }

    private async getImageId(imageName: string): Promise<string | null> {
        try {
            const result = childProcess.execSync(`docker inspect --format='{{.Id}}' ${imageName} 2>/dev/null || echo ""`).toString().trim();
            return result || null;
        } catch {
            return null;
        }
    }

    async restartSelf(): Promise<void> {
        const composeFile = process.env.DOCKGE_STACK_DIR || process.env.COMPOSE_DIR;

        if (composeFile) {
            await this.execCommand("docker", ["compose", "-f", composeFile, "up", "-d", "--pull", "always"]);
        } else {
            const hostname = process.env.HOSTNAME || process.env.HOST;
            if (hostname) {
                await this.execCommand("docker", ["restart", hostname]);
            } else {
                throw new Error("Could not determine how to restart the container");
            }
        }

        setTimeout(() => {
            process.exit(0);
        }, 1000);
    }

    async execCommand(command: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            log.debug("auto-updater", `Executing: ${command} ${args.join(" ")}`);

            const proc = childProcess.spawn(command, args, {
                stdio: "pipe"
            });

            let stdout = "";
            let stderr = "";

            proc.stdout?.on("data", (data) => {
                stdout += data.toString();
                log.debug("auto-updater", `[stdout] ${data.toString().trim()}`);
            });

            proc.stderr?.on("data", (data) => {
                stderr += data.toString();
                log.debug("auto-updater", `[stderr] ${data.toString().trim()}`);
            });

            proc.on("close", (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
                }
            });

            proc.on("error", (err) => {
                reject(err);
            });
        });
    }

    private async execCommandWithRetry(command: string, args: string[], retries = MAX_RETRY_ATTEMPTS): Promise<string> {
        let lastError: Error | undefined;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await this.execCommand(command, args);
            } catch (e) {
                lastError = e instanceof Error ? e : new Error(String(e));
                if (attempt < retries) {
                    log.warn("auto-updater", `Command failed (attempt ${attempt}/${retries}), retrying in ${RETRY_DELAY_MS / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                }
            }
        }
        throw lastError;
    }

    async writeLog(entry: UpdateLogEntry): Promise<number | undefined> {
        try {
            const result = await R.knex("update_log").insert({
                image_name: entry.image_name,
                target_type: entry.target_type,
                target_name: entry.target_name || null,
                old_version: entry.old_version || null,
                new_version: entry.new_version || null,
                status: entry.status,
                error_message: entry.error_message || null,
                duration_ms: entry.duration_ms || null,
                rollback_image: entry.rollback_image || null,
                created_at: new Date().toISOString(),
            });
            return result[0];
        } catch (e) {
            log.error("auto-updater", "Failed to write update log: " + e);
            return undefined;
        }
    }

    async updateLog(id: number, updates: Partial<UpdateLogEntry>): Promise<void> {
        try {
            await R.knex("update_log").where("id", id).update({
                status: updates.status,
                error_message: updates.error_message || null,
                duration_ms: updates.duration_ms || null,
            });
        } catch (e) {
            log.error("auto-updater", "Failed to update log: " + e);
        }
    }

    async getLogs(limit = 50, offset = 0): Promise<UpdateLogEntry[]> {
        try {
            return await R.knex("update_log")
                .select("*")
                .orderBy("created_at", "desc")
                .limit(limit)
                .offset(offset);
        } catch (e) {
            log.error("auto-updater", "Failed to get update logs: " + e);
            return [];
        }
    }

    async getLogCount(): Promise<number> {
        try {
            const result = await R.knex("update_log").count("id as count").first();
            return result?.count as number || 0;
        } catch {
            return 0;
        }
    }

    async clearLogs(olderThanDays?: number): Promise<number> {
        try {
            let query = R.knex("update_log");
            if (olderThanDays) {
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - olderThanDays);
                query = query.where("created_at", "<", cutoff.toISOString());
            }
            const count = await query.count("id as count").first();
            await query.delete();
            return count?.count as number || 0;
        } catch (e) {
            log.error("auto-updater", "Failed to clear logs: " + e);
            return 0;
        }
    }

    async autoCleanupLogs(): Promise<void> {
        const maxEntries = await Settings.get("maxUpdateLogEntries") || DEFAULT_MAX_LOG_ENTRIES;
        const count = await this.getLogCount();
        if (count > maxEntries) {
            const excess = count - maxEntries;
            try {
                const oldLogs = await R.knex("update_log")
                    .select("id")
                    .orderBy("created_at", "asc")
                    .limit(excess);
                if (oldLogs.length > 0) {
                    const ids = oldLogs.map((l: { id: number }) => l.id);
                    await R.knex("update_log").whereIn("id", ids).delete();
                    log.info("auto-updater", `Cleaned up ${ids.length} old update logs`);
                }
            } catch (e) {
                log.error("auto-updater", "Failed to auto-cleanup logs: " + e);
            }
        }
    }

    async getStatus(): Promise<AutoUpdateStatus> {
        const enabled = await Settings.get("autoUpdate") ?? false;
        const updateWindow = await Settings.get("autoUpdateWindow") ?? "any";
        const lastCheck = await Settings.get("lastUpdateCheck");
        const lastAttempt = await Settings.get("lastUpdateAttempt");
        const lastError = await Settings.get("lastError");

        return {
            enabled,
            updateWindow,
            lastCheck,
            lastAttempt,
            lastError,
            latestVersion: this.latestVersion,
            currentVersion: this.currentVersion,
            updateAvailable: !!this.latestVersion,
            isUpdating: this.isUpdating,
            rollbackAvailable: !!this.rollbackImage,
            retryCount: this.retryCount,
            maxRetries: MAX_RETRY_ATTEMPTS,
        };
    }

    async setEnabled(enabled: boolean): Promise<void> {
        await Settings.set("autoUpdate", enabled);
        log.info("auto-updater", `Auto-update ${enabled ? "enabled" : "disabled"}`);
    }

    async setUpdateWindow(window: string): Promise<void> {
        await Settings.set("autoUpdateWindow", window);
        log.info("auto-updater", `Update window set to: ${window}`);
    }

    getLatestVersion(): string | undefined {
        return this.latestVersion;
    }

    getCurrentVersion(): string {
        return this.currentVersion;
    }

    isUpdateInProgress(): boolean {
        return this.isUpdating;
    }

    getRollbackImage(): string | undefined {
        return this.rollbackImage;
    }
}

const autoUpdater = new AutoUpdater();
export default autoUpdater;
