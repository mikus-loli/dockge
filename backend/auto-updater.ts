import { DockgeServer } from "./dockge-server";
import { Stack } from "./stack";
import { log } from "./log";
import { Settings } from "./settings";
import { R } from "redbean-node";
import childProcessAsync from "promisify-child-process";
import yaml from "yaml";
import dayjs from "dayjs";

export interface ImageInfo {
    image: string;
    tag: string;
    registry: string;
    repository: string;
}

export interface UpdateCheckResult {
    stackName: string;
    image: string;
    currentDigest: string;
    remoteDigest: string;
    hasUpdate: boolean;
    checkedAt: string;
}

export interface UpdateLogEntry {
    id?: number;
    stackName: string;
    type: "check" | "update" | "rollback" | "error";
    status: "success" | "failed" | "in_progress";
    message: string;
    oldDigest?: string;
    newDigest?: string;
    timestamp: string;
}

export class AutoUpdater {
    protected server: DockgeServer;
    protected checkInterval?: NodeJS.Timeout;
    isChecking = false;
    isUpdating = false;

    constructor(server: DockgeServer) {
        this.server = server;
    }

    async start() {
        const enabled = await Settings.get("autoUpdateEnabled");
        if (!enabled) {
            log.info("auto-update", "Auto-update is disabled");
            return;
        }

        const intervalMinutes = (await Settings.get("autoUpdateCheckInterval")) || 60;
        log.info("auto-update", `Starting auto-update checker, interval: ${intervalMinutes} minutes`);

        await this.checkAllStacks();

        this.checkInterval = setInterval(async () => {
            if (!this.isChecking) {
                await this.checkAllStacks();
            }
        }, intervalMinutes * 60 * 1000);
    }

    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = undefined;
            log.info("auto-update", "Auto-update checker stopped");
        }
    }

    async restart() {
        this.stop();
        await this.start();
    }

    async checkAllStacks() {
        this.isChecking = true;
        try {
            const enabled = await Settings.get("autoUpdateEnabled");
            if (!enabled) {
                return;
            }

            log.info("auto-update", "Checking all stacks for image updates...");

            const stackList = await Stack.getStackList(this.server, true);
            const results: UpdateCheckResult[] = [];

            for (const [name, stack] of stackList) {
                if (!stack.isManagedByDockge) {
                    continue;
                }

                try {
                    const images = this.parseImagesFromCompose(stack.composeYAML);
                    for (const imageInfo of images) {
                        const result = await this.checkImageUpdate(name, imageInfo);
                        if (result) {
                            results.push(result);

                            if (result.hasUpdate) {
                                log.info("auto-update", `Update available for ${name}: ${imageInfo.image}:${imageInfo.tag}`);
                                await this.addUpdateLog({
                                    stackName: name,
                                    type: "check",
                                    status: "success",
                                    message: `Update available: ${imageInfo.image}:${imageInfo.tag}`,
                                    oldDigest: result.currentDigest,
                                    newDigest: result.remoteDigest,
                                    timestamp: dayjs().toISOString(),
                                });
                                await this.sendNotification("update_available", name, `${imageInfo.image}:${imageInfo.tag}`);

                                const autoDeploy = await Settings.get("autoUpdateAutoDeploy");
                                if (autoDeploy) {
                                    await this.executeUpdate(name);
                                }
                            }
                        }
                    }
                } catch (e) {
                    if (e instanceof Error) {
                        log.error("auto-update", `Error checking stack ${name}: ${e.message}`);
                    }
                }
            }

            this.server.io.emit("autoUpdateCheckResult", results);
        } finally {
            this.isChecking = false;
        }
    }

    parseImagesFromCompose(composeYAML: string): ImageInfo[] {
        const images: ImageInfo[] = [];
        try {
            const doc = yaml.parse(composeYAML);
            if (!doc || !doc.services) {
                return images;
            }

            for (const [serviceName, service] of Object.entries(doc.services as Record<string, Record<string, unknown>>)) {
                if (service.image && typeof service.image === "string") {
                    const imageInfo = this.parseImageString(service.image);
                    if (imageInfo) {
                        images.push(imageInfo);
                    }
                }
            }
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to parse compose YAML: ${e.message}`);
            }
        }
        return images;
    }

    parseImageString(imageStr: string): ImageInfo | null {
        let registry = "docker.io";
        let repository: string;
        let tag = "latest";

        let parts = imageStr.split("/");
        if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":"))) {
            registry = parts[0];
            parts = parts.slice(1);
        }

        const imagePart = parts.join("/");
        const tagSplit = imagePart.split(":");
        repository = tagSplit[0];
        if (tagSplit.length > 1) {
            tag = tagSplit[1];
        }

        if (registry === "docker.io" && !repository.includes("/")) {
            repository = "library/" + repository;
        }

        return {
            image: imageStr,
            tag,
            registry,
            repository,
        };
    }

    async checkImageUpdate(stackName: string, imageInfo: ImageInfo): Promise<UpdateCheckResult | null> {
        try {
            const currentDigest = await this.getLocalImageDigest(imageInfo.image);
            const remoteDigest = await this.getRemoteImageDigest(imageInfo);

            return {
                stackName,
                image: imageInfo.image,
                currentDigest: currentDigest || "unknown",
                remoteDigest: remoteDigest || "unknown",
                hasUpdate: !!(currentDigest && remoteDigest && currentDigest !== remoteDigest),
                checkedAt: dayjs().toISOString(),
            };
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to check image update for ${imageInfo.image}: ${e.message}`);
            }
            return null;
        }
    }

    protected async getLocalImageDigest(imageStr: string): Promise<string | null> {
        try {
            const normalizedName = imageStr.includes("/") ? imageStr : "docker.io/library/" + imageStr;
            const tagSplit = normalizedName.split(":");
            const nameOnly = tagSplit[0];

            const res = await childProcessAsync.spawn("docker", [
                "image", "inspect",
                "--format", "{{index .RepoDigests 0}}",
                imageStr,
            ], {
                encoding: "utf-8",
                timeout: 30000,
            });

            const output = res.stdout?.toString().trim();
            if (output && output.includes("@")) {
                return output.split("@")[1];
            }

            const idRes = await childProcessAsync.spawn("docker", [
                "image", "inspect",
                "--format", "{{.Id}}",
                imageStr,
            ], {
                encoding: "utf-8",
                timeout: 30000,
            });

            return idRes.stdout?.toString().trim() || null;
        } catch (e) {
            return null;
        }
    }

    protected async getRemoteImageDigest(imageInfo: ImageInfo): Promise<string | null> {
        try {
            const res = await childProcessAsync.spawn("docker", [
                "buildx",
                "imagetools",
                "inspect",
                `${imageInfo.registry === "docker.io" ? "" : imageInfo.registry + "/"}${imageInfo.repository}:${imageInfo.tag}`,
                "--format", "{{.Digest}}",
            ], {
                encoding: "utf-8",
                timeout: 60000,
            });

            const digest = res.stdout?.toString().trim();
            if (digest && digest.startsWith("sha256:")) {
                return digest;
            }
            return null;
        } catch (e) {
            try {
                const pullRes = await childProcessAsync.spawn("docker", [
                    "manifest",
                    "inspect",
                    `${imageInfo.registry === "docker.io" ? "" : imageInfo.registry + "/"}${imageInfo.repository}:${imageInfo.tag}`,
                ], {
                    encoding: "utf-8",
                    timeout: 60000,
                });

                const manifest = JSON.parse(pullRes.stdout?.toString() || "{}");
                if (manifest.config && manifest.config.digest) {
                    return manifest.config.digest;
                }
                if (manifest.digest) {
                    return manifest.digest;
                }
                return null;
            } catch (e2) {
                return null;
            }
        }
    }

    async executeUpdate(stackName: string): Promise<boolean> {
        if (this.isUpdating) {
            log.warn("auto-update", "Another update is in progress, skipping");
            return false;
        }

        this.isUpdating = true;
        try {
            const stack = await Stack.getStack(this.server, stackName);

            const preUpdateDigests = await this.captureImageDigests(stack);

            await this.addUpdateLog({
                stackName,
                type: "update",
                status: "in_progress",
                message: `Starting update for stack ${stackName}`,
                timestamp: dayjs().toISOString(),
            });

            await this.savePreUpdateState(stackName, preUpdateDigests);

            const pullRes = await childProcessAsync.spawn("docker", stack.getComposeOptions("pull"), {
                cwd: stack.path,
                encoding: "utf-8",
                timeout: 300000,
            });

            if (pullRes.code !== 0 && pullRes.code !== null) {
                throw new Error(`docker compose pull failed with code ${pullRes.code}`);
            }

            await stack.updateStatus();
            const wasRunning = stack.status === 3;

            if (wasRunning) {
                const upRes = await childProcessAsync.spawn("docker", stack.getComposeOptions("up", "-d", "--remove-orphans"), {
                    cwd: stack.path,
                    encoding: "utf-8",
                    timeout: 300000,
                });

                if (upRes.code !== 0 && upRes.code !== null) {
                    throw new Error(`docker compose up failed with code ${upRes.code}`);
                }
            }

            const postUpdateDigests = await this.captureImageDigests(stack);

            await this.addUpdateLog({
                stackName,
                type: "update",
                status: "success",
                message: `Stack ${stackName} updated successfully`,
                oldDigest: JSON.stringify(preUpdateDigests),
                newDigest: JSON.stringify(postUpdateDigests),
                timestamp: dayjs().toISOString(),
            });

            await this.sendNotification("update_success", stackName);

            this.server.sendStackList();
            return true;
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to update stack ${stackName}: ${e.message}`);

                await this.addUpdateLog({
                    stackName,
                    type: "error",
                    status: "failed",
                    message: `Update failed: ${e.message}`,
                    timestamp: dayjs().toISOString(),
                });

                await this.sendNotification("update_failed", stackName, e.message);

                const autoRollback = await Settings.get("autoUpdateAutoRollback");
                if (autoRollback) {
                    log.info("auto-update", `Auto-rollback enabled, rolling back stack ${stackName}`);
                    await this.executeRollback(stackName);
                }
            }
            return false;
        } finally {
            this.isUpdating = false;
        }
    }

    async executeRollback(stackName: string): Promise<boolean> {
        try {
            const savedState = await this.getPreUpdateState(stackName);
            if (!savedState) {
                throw new Error("No pre-update state found for rollback");
            }

            await this.addUpdateLog({
                stackName,
                type: "rollback",
                status: "in_progress",
                message: `Starting rollback for stack ${stackName}`,
                timestamp: dayjs().toISOString(),
            });

            const stack = await Stack.getStack(this.server, stackName);

            const digests: Record<string, string> = JSON.parse(savedState);

            for (const [image, digest] of Object.entries(digests)) {
                try {
                    await childProcessAsync.spawn("docker", [
                        "pull", `${image}@${digest}`,
                    ], {
                        encoding: "utf-8",
                        timeout: 300000,
                    });
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("auto-update", `Could not pull old digest for ${image}: ${e.message}`);
                    }
                }
            }

            await stack.updateStatus();
            const wasRunning = stack.status === 3;

            if (wasRunning) {
                await childProcessAsync.spawn("docker", stack.getComposeOptions("up", "-d", "--force-recreate", "--remove-orphans"), {
                    cwd: stack.path,
                    encoding: "utf-8",
                    timeout: 300000,
                });
            }

            await this.addUpdateLog({
                stackName,
                type: "rollback",
                status: "success",
                message: `Stack ${stackName} rolled back successfully`,
                timestamp: dayjs().toISOString(),
            });

            await this.sendNotification("rollback_success", stackName);

            this.server.sendStackList();
            return true;
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to rollback stack ${stackName}: ${e.message}`);

                await this.addUpdateLog({
                    stackName,
                    type: "rollback",
                    status: "failed",
                    message: `Rollback failed: ${e.message}`,
                    timestamp: dayjs().toISOString(),
                });

                await this.sendNotification("rollback_failed", stackName, e.message);
            }
            return false;
        }
    }

    protected async captureImageDigests(stack: Stack): Promise<Record<string, string>> {
        const digests: Record<string, string> = {};
        const images = this.parseImagesFromCompose(stack.composeYAML);

        for (const imageInfo of images) {
            const digest = await this.getLocalImageDigest(imageInfo.image);
            if (digest) {
                digests[imageInfo.image] = digest;
            }
        }

        return digests;
    }

    protected async savePreUpdateState(stackName: string, digests: Record<string, string>) {
        await Settings.set(`autoUpdatePreState_${stackName}`, JSON.stringify(digests));
    }

    protected async getPreUpdateState(stackName: string): Promise<string | null> {
        return await Settings.get(`autoUpdatePreState_${stackName}`);
    }

    async addUpdateLog(entry: UpdateLogEntry) {
        try {
            let bean = R.dispense("update_log");
            bean.stackName = entry.stackName;
            bean.type = entry.type;
            bean.status = entry.status;
            bean.message = entry.message;
            bean.oldDigest = entry.oldDigest || "";
            bean.newDigest = entry.newDigest || "";
            bean.timestamp = entry.timestamp;
            await R.store(bean);
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to add update log: ${e.message}`);
            }
        }
    }

    async getUpdateLogs(stackName?: string, limit = 100): Promise<UpdateLogEntry[]> {
        try {
            let query = R.knex("update_log").orderBy("timestamp", "desc").limit(limit);
            if (stackName) {
                query = query.where("stackName", stackName);
            }
            const rows = await query;
            return rows.map((row: Record<string, unknown>) => ({
                id: row.id as number,
                stackName: row.stackName as string,
                type: row.type as UpdateLogEntry["type"],
                status: row.status as UpdateLogEntry["status"],
                message: row.message as string,
                oldDigest: (row.oldDigest as string) || "",
                newDigest: (row.newDigest as string) || "",
                timestamp: row.timestamp as string,
            }));
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to get update logs: ${e.message}`);
            }
            return [];
        }
    }

    async clearUpdateLogs(beforeDays = 30) {
        try {
            const cutoff = dayjs().subtract(beforeDays, "day").toISOString();
            await R.exec("DELETE FROM update_log WHERE timestamp < ?", [cutoff]);
            log.info("auto-update", `Cleared update logs older than ${beforeDays} days`);
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to clear update logs: ${e.message}`);
            }
        }
    }

    async getUpdateStatus(): Promise<Record<string, unknown>> {
        const enabled = await Settings.get("autoUpdateEnabled") || false;
        const checkInterval = await Settings.get("autoUpdateCheckInterval") || 60;
        const autoDeploy = await Settings.get("autoUpdateAutoDeploy") || false;
        const autoRollback = await Settings.get("autoUpdateAutoRollback") || false;
        const logRetentionDays = await Settings.get("autoUpdateLogRetentionDays") || 30;
        const excludedStacks = await Settings.get("autoUpdateExcludedStacks") || [];

        return {
            enabled,
            checkInterval,
            autoDeploy,
            autoRollback,
            logRetentionDays,
            excludedStacks,
            isChecking: this.isChecking,
            isUpdating: this.isUpdating,
        };
    }

    async saveUpdateSettings(settings: Record<string, unknown>) {
        const keys = [
            "autoUpdateEnabled",
            "autoUpdateCheckInterval",
            "autoUpdateAutoDeploy",
            "autoUpdateAutoRollback",
            "autoUpdateLogRetentionDays",
            "autoUpdateExcludedStacks",
        ];

        for (const key of keys) {
            if (settings[key] !== undefined) {
                await Settings.set(key, settings[key] as string | number | boolean | object);
            }
        }

        if (settings.autoUpdateEnabled !== undefined || settings.autoUpdateCheckInterval !== undefined) {
            await this.restart();
        }

        if (settings.autoUpdateLogRetentionDays !== undefined) {
            await this.clearUpdateLogs(settings.autoUpdateLogRetentionDays as number);
        }
    }

    protected async sendNotification(type: string, stackName: string, detail?: string) {
        try {
            const enabled = await Settings.get("autoUpdateNotifications") !== false;
            if (!enabled) {
                return;
            }

            this.server.io.emit("autoUpdateNotification", {
                type,
                stackName,
                detail,
                timestamp: dayjs().toISOString(),
            });
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to send notification: ${e.message}`);
            }
        }
    }

    async checkSingleStack(stackName: string): Promise<UpdateCheckResult[]> {
        const stack = await Stack.getStack(this.server, stackName);
        const images = this.parseImagesFromCompose(stack.composeYAML);
        const results: UpdateCheckResult[] = [];

        for (const imageInfo of images) {
            const result = await this.checkImageUpdate(stackName, imageInfo);
            if (result) {
                results.push(result);
            }
        }

        return results;
    }
}
