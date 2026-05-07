import { log } from "./log";
import { Settings } from "./settings";
import { DockgeServer } from "./dockge-server";
import childProcess from "child_process";
import compareVersions from "compare-versions";
import packageJSON from "../package.json";

const CHECK_URL = "https://dockge.kuma.pet/version";
const AUTO_UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60;

interface VersionInfo {
    slow?: string;
    beta?: string;
}

interface AutoUpdateStatus {
    enabled: boolean;
    updateWindow?: string;
    lastCheck?: number;
    lastAttempt?: number;
    lastError?: string;
    latestVersion?: string;
    currentVersion: string;
    updateAvailable: boolean;
}

class AutoUpdater {
    private server: DockgeServer | null = null;
    private interval?: NodeJS.Timeout;
    private isUpdating = false;
    private currentVersion = packageJSON.version;
    private latestVersion?: string;

    async init(server: DockgeServer) {
        this.server = server;
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

            if (this.latestVersion) {
                log.info("auto-updater", `New version available: ${this.latestVersion}`);
            }

            return data;
        } catch (e) {
            log.error("auto-updater", "Failed to check for updates: " + e);
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

        const [start, end] = window.split("-").map(h => parseInt(h.trim(), 10));
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

        try {
            await Settings.set("lastUpdateAttempt", Date.now());

            const imageName = this.getDockerImageName();
            if (!imageName) {
                throw new Error("Could not determine Docker image name");
            }

            log.info("auto-updater", `Pulling latest image: ${imageName}`);
            await this.execCommand("docker", ["pull", imageName]);

            log.info("auto-updater", "Restarting container...");
            await this.restartSelf();

            log.info("auto-updater", "Update completed successfully");
            await Settings.set("lastError", "");
            return true;
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            log.error("auto-updater", "Update failed: " + errorMsg);
            await Settings.set("lastError", errorMsg);
            return false;
        } finally {
            this.isUpdating = false;
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

    async execCommand(command: string, args: string[]): Promise<void> {
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
                    resolve();
                } else {
                    reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
                }
            });

            proc.on("error", (err) => {
                reject(err);
            });
        });
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
            updateAvailable: !!this.latestVersion
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
}

const autoUpdater = new AutoUpdater();
export default autoUpdater;
