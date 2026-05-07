import { DockgeServer } from "./dockge-server";
import { Settings } from "./settings";
import { Stack } from "./stack";
import { log } from "./log";
import { Cron } from "croner";
import { R } from "redbean-node";
import childProcessAsync from "promisify-child-process";
import yaml from "yaml";
import { RUNNING } from "../common/util-common";

export interface AutoUpdateConfig {
    enabled: boolean;
    schedule: string;
    pruneImages: boolean;
    notifyOnUpdate: boolean;
    notifyOnError: boolean;
}

export interface UpdateLogEntry {
    id: number;
    stackName: string;
    status: string;
    errorMessage: string;
    oldImages: string;
    newImages: string;
    createdAt: string;
}

const DEFAULT_CONFIG: AutoUpdateConfig = {
    enabled: false,
    schedule: "0 4 * * *",
    pruneImages: false,
    notifyOnUpdate: true,
    notifyOnError: true,
};

const X_DOCKGE_AUTO_UPDATE = "x-dockge-auto-update";

export class AutoUpdater {
    private server: DockgeServer;
    private cronJob?: Cron;
    private running = false;

    constructor(server: DockgeServer) {
        this.server = server;
    }

    async start() {
        const config = await this.getConfig();
        this.applyCron(config.schedule);
        log.info("auto-updater", `Auto-updater initialized (enabled: ${config.enabled}, schedule: ${config.schedule})`);
    }

    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = undefined;
        }
    }

    private applyCron(schedule: string) {
        if (this.cronJob) {
            this.cronJob.stop();
        }

        this.cronJob = Cron(schedule, {
            protect: true,
        }, async () => {
            const config = await this.getConfig();
            if (!config.enabled) {
                return;
            }
            await this.runAutoUpdate();
        });
    }

    async getConfig(): Promise<AutoUpdateConfig> {
        const saved = await Settings.get("autoUpdateConfig") as Record<string, unknown> | null;
        if (saved && typeof saved === "object") {
            return { ...DEFAULT_CONFIG, ...saved };
        }
        return { ...DEFAULT_CONFIG };
    }

    async setConfig(config: Partial<AutoUpdateConfig>) {
        const current = await this.getConfig();
        const merged = { ...current, ...config };
        await Settings.set("autoUpdateConfig", merged, "autoUpdate");

        if (config.schedule && config.schedule !== current.schedule) {
            this.applyCron(merged.schedule);
        }

        log.info("auto-updater", `Config updated: ${JSON.stringify(merged)}`);
        return merged;
    }

    async getStackAutoUpdate(stackName: string): Promise<boolean> {
        try {
            const stack = await Stack.getStack(this.server, stackName);
            const composeYAML = stack.composeYAML;
            const parsed = yaml.parse(composeYAML);
            return parsed?.[X_DOCKGE_AUTO_UPDATE] === true;
        } catch (e) {
            return false;
        }
    }

    async setStackAutoUpdate(stackName: string, enabled: boolean): Promise<void> {
        const stack = await Stack.getStack(this.server, stackName);
        const composeYAML = stack.composeYAML;
        const parsed = yaml.parse(composeYAML);

        if (!parsed) {
            throw new Error("Invalid compose YAML");
        }

        if (enabled) {
            parsed[X_DOCKGE_AUTO_UPDATE] = true;
        } else {
            delete parsed[X_DOCKGE_AUTO_UPDATE];
        }

        const newYAML = yaml.stringify(parsed);
        const newStack = new Stack(this.server, stackName, newYAML, stack.composeENV, false);
        await newStack.save(false);

        log.info("auto-updater", `Stack ${stackName} auto-update ${enabled ? "enabled" : "disabled"}`);
    }

    async getAutoUpdateStacks(): Promise<string[]> {
        try {
            const stackList = await Stack.getStackList(this.server, true);
            const result: string[] = [];

            for (const [name, stack] of stackList) {
                if (stack.isManagedByDockge) {
                    try {
                        const composeYAML = stack.composeYAML;
                        const parsed = yaml.parse(composeYAML);
                        if (parsed?.[X_DOCKGE_AUTO_UPDATE] === true) {
                            result.push(name);
                        }
                    } catch (e) {
                        // skip invalid YAML
                    }
                }
            }

            return result;
        } catch (e) {
            log.error("auto-updater", "Failed to get auto-update stacks: " + e);
            return [];
        }
    }

    async getImageDigests(stackName: string): Promise<Map<string, string>> {
        const digests = new Map<string, string>();

        try {
            const stack = await Stack.getStack(this.server, stackName);
            const composeYAML = stack.composeYAML;
            const parsed = yaml.parse(composeYAML);

            if (!parsed?.services) {
                return digests;
            }

            for (const [serviceName, serviceConfig] of Object.entries(parsed.services)) {
                const config = serviceConfig as Record<string, unknown>;
                const image = config.image as string | undefined;
                if (!image) {
                    continue;
                }

                try {
                    const containerName = `${stackName}-${serviceName}-1`;
                    const res = await childProcessAsync.spawn("docker", [
                        "inspect", "--format", "{{.Image}}", containerName,
                    ], { encoding: "utf-8" });

                    if (res.stdout) {
                        const digest = res.stdout.toString().trim();
                        if (digest) {
                            digests.set(serviceName, digest);
                        }
                    }
                } catch (e) {
                    // container may not exist
                }
            }
        } catch (e) {
            log.warn("auto-updater", `Failed to get image digests for ${stackName}: ${e}`);
        }

        return digests;
    }

    async runAutoUpdate() {
        if (this.running) {
            log.warn("auto-updater", "Auto-update is already running, skipping");
            return;
        }

        this.running = true;
        log.info("auto-updater", "Starting auto-update check...");

        try {
            const config = await this.getConfig();
            const stackNames = await this.getAutoUpdateStacks();

            if (stackNames.length === 0) {
                log.info("auto-updater", "No stacks configured for auto-update");
                return;
            }

            log.info("auto-updater", `Found ${stackNames.length} stack(s) configured for auto-update`);

            for (const stackName of stackNames) {
                try {
                    await this.updateStack(stackName, config);
                } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : String(e);
                    log.error("auto-updater", `Failed to auto-update stack ${stackName}: ${errorMsg}`);

                    if (config.notifyOnError) {
                        this.broadcast("autoUpdateError", {
                            stackName,
                            error: errorMsg,
                        });
                    }

                    await this.logUpdate(stackName, "error", errorMsg, "", "");
                }
            }

            if (config.pruneImages) {
                try {
                    log.info("auto-updater", "Pruning unused images...");
                    await childProcessAsync.spawn("docker", ["image", "prune", "-f"], {
                        encoding: "utf-8",
                    });
                    log.info("auto-updater", "Image pruning completed");
                } catch (e) {
                    log.warn("auto-updater", "Failed to prune images: " + e);
                }
            }

        } catch (e) {
            log.error("auto-updater", "Auto-update run failed: " + e);
        } finally {
            this.running = false;
            log.info("auto-updater", "Auto-update check completed");
        }
    }

    async updateStack(stackName: string, config?: AutoUpdateConfig) {
        if (!config) {
            config = await this.getConfig();
        }

        log.info("auto-updater", `Checking stack: ${stackName}`);

        const oldDigests = await this.getImageDigests(stackName);
        const oldImagesStr = JSON.stringify(Object.fromEntries(oldDigests));

        const stack = await Stack.getStack(this.server, stackName);
        const oldComposeYAML = stack.composeYAML;

        log.info("auto-updater", `Pulling images for ${stackName}...`);

        try {
            const pullResult = await childProcessAsync.spawn("docker",
                stack.getComposeOptions("pull"),
                {
                    cwd: stack.fullPath,
                    encoding: "utf-8",
                }
            );

            const pullOutput = pullOutputToString(pullResult.stdout);
            log.info("auto-updater", `Pull completed for ${stackName}`);

            const newDigests = await this.getImageDigests(stackName);
            const newImagesStr = JSON.stringify(Object.fromEntries(newDigests));

            const hasChanges = this.detectChanges(oldDigests, newDigests);

            if (!hasChanges) {
                log.info("auto-updater", `No updates available for ${stackName}`);
                await this.logUpdate(stackName, "no_update", "", oldImagesStr, newImagesStr);
                return;
            }

            log.info("auto-updater", `Updates detected for ${stackName}, redeploying...`);

            await stack.updateStatus();

            if (stack.status === RUNNING) {
                const upResult = await childProcessAsync.spawn("docker",
                    stack.getComposeOptions("up", "-d", "--remove-orphans"),
                    {
                        cwd: stack.fullPath,
                        encoding: "utf-8",
                    }
                );

                const upOutput = pullOutputToString(upResult.stdout);
                log.info("auto-updater", `Redeploy completed for ${stackName}`);
            } else {
                log.info("auto-updater", `Stack ${stackName} is not running, skipping redeploy`);
            }

            await this.logUpdate(stackName, "success", "", oldImagesStr, newImagesStr);
            await this.saveBackup(stackName, oldComposeYAML);

            this.server.sendStackList();

            if (config.notifyOnUpdate) {
                this.broadcast("autoUpdateSuccess", {
                    stackName,
                    oldImages: Object.fromEntries(oldDigests),
                    newImages: Object.fromEntries(newDigests),
                });
            }

        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            log.error("auto-updater", `Update failed for ${stackName}: ${errorMsg}`);

            await this.logUpdate(stackName, "error", errorMsg, oldImagesStr, "");

            if (config.notifyOnError) {
                this.broadcast("autoUpdateError", {
                    stackName,
                    error: errorMsg,
                });
            }

            throw e;
        }
    }

    private detectChanges(oldDigests: Map<string, string>, newDigests: Map<string, string>): boolean {
        if (oldDigests.size === 0 && newDigests.size > 0) {
            return true;
        }

        for (const [service, newDigest] of newDigests) {
            const oldDigest = oldDigests.get(service);
            if (!oldDigest || oldDigest !== newDigest) {
                return true;
            }
        }

        return false;
    }

    private async saveBackup(stackName: string, composeYAML: string) {
        try {
            const bean = R.dispense("auto_update_backup");
            bean.stack_name = stackName;
            bean.compose_yaml = composeYAML;
            bean.created_at = new Date().toISOString();
            await R.store(bean);
            log.info("auto-updater", `Backup saved for ${stackName}`);
        } catch (e) {
            log.warn("auto-updater", `Failed to save backup for ${stackName}: ${e}`);
        }
    }

    async rollback(stackName: string): Promise<void> {
        log.info("auto-updater", `Rolling back stack: ${stackName}`);

        const backup = await R.findOne("auto_update_backup",
            " stack_name = ? ORDER BY id DESC ",
            [stackName]
        );

        if (!backup) {
            throw new Error("No backup found for stack " + stackName);
        }

        const stack = await Stack.getStack(this.server, stackName);
        const currentYAML = stack.composeYAML;
        const backupYAML = backup.compose_yaml;

        const restoredStack = new Stack(this.server, stackName, backupYAML, stack.composeENV, false);
        await restoredStack.save(false);

        await stack.updateStatus();

        if (stack.status === RUNNING) {
            await childProcessAsync.spawn("docker",
                restoredStack.getComposeOptions("up", "-d", "--remove-orphans"),
                {
                    cwd: restoredStack.fullPath,
                    encoding: "utf-8",
                }
            );
        }

        await this.logUpdate(stackName, "rollback", "", "", "");

        this.server.sendStackList();

        this.broadcast("autoUpdateRollback", {
            stackName,
        });

        log.info("auto-updater", `Rollback completed for ${stackName}`);
    }

    async getUpdateLog(stackName?: string, limit = 50): Promise<UpdateLogEntry[]> {
        let query = "SELECT * FROM auto_update_log";
        const params: unknown[] = [];

        if (stackName) {
            query += " WHERE stack_name = ?";
            params.push(stackName);
        }

        query += " ORDER BY id DESC LIMIT ?";
        params.push(limit);

        const rows = await R.getAll(query, params as (string | number)[]);
        return rows.map((row: Record<string, unknown>) => ({
            id: row.id as number,
            stackName: row.stack_name as string,
            status: row.status as string,
            errorMessage: row.error_message as string,
            oldImages: row.old_images as string,
            newImages: row.new_images as string,
            createdAt: row.created_at as string,
        }));
    }

    async clearLog(stackName?: string): Promise<void> {
        if (stackName) {
            await R.exec("DELETE FROM auto_update_log WHERE stack_name = ?", [stackName]);
        } else {
            await R.exec("DELETE FROM auto_update_log", []);
        }
    }

    private async logUpdate(
        stackName: string,
        status: string,
        errorMessage: string,
        oldImages: string,
        newImages: string,
    ) {
        try {
            const bean = R.dispense("auto_update_log");
            bean.stack_name = stackName;
            bean.status = status;
            bean.error_message = errorMessage;
            bean.old_images = oldImages;
            bean.new_images = newImages;
            bean.created_at = new Date().toISOString();
            await R.store(bean);
        } catch (e) {
            log.warn("auto-updater", "Failed to log update: " + e);
        }
    }

    private broadcast(event: string, data: object) {
        try {
            this.server.io.emit(event, data);
        } catch (e) {
            log.warn("auto-updater", "Failed to broadcast event: " + e);
        }
    }

    get isRunning(): boolean {
        return this.running;
    }
}

function pullOutputToString(output: unknown): string {
    if (!output) {
        return "";
    }
    if (Buffer.isBuffer(output)) {
        return output.toString("utf-8");
    }
    return String(output);
}
