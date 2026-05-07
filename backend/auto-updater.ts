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
}

export interface UpdateCheckResult {
    stackName: string;
    image: string;
    currentImageId: string;
    newImageId: string;
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
        if (!enabled || enabled === "false") {
            log.info("auto-update", "Auto-update is disabled");
            return;
        }

        const intervalMinutes = parseInt(await Settings.get("autoUpdateCheckInterval") as string) || 60;
        log.info("auto-update", `Starting auto-update checker, interval: ${intervalMinutes} minutes`);

        this.checkInterval = setInterval(async () => {
            if (!this.isChecking && !this.isUpdating) {
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
            if (!enabled || enabled === "false") {
                return;
            }

            log.info("auto-update", "Checking all stacks for image updates...");

            const excludedStacks = await this.getExcludedStacks();
            const stackList = await Stack.getStackList(this.server, true);
            const results: UpdateCheckResult[] = [];

            for (const [name, stack] of stackList) {
                if (!stack.isManagedByDockge) {
                    continue;
                }

                if (excludedStacks.includes(name)) {
                    log.debug("auto-update", `Skipping excluded stack: ${name}`);
                    continue;
                }

                try {
                    const result = await this.checkStackUpdate(name, stack);
                    if (result) {
                        results.push(...result);

                        const updatedImages = result.filter(r => r.hasUpdate);
                        if (updatedImages.length > 0) {
                            const imageList = updatedImages.map(r => r.image).join(", ");
                            log.info("auto-update", `Update available for ${name}: ${imageList}`);
                            await this.addUpdateLog({
                                stackName: name,
                                type: "check",
                                status: "success",
                                message: `Update available: ${imageList}`,
                                oldDigest: updatedImages.map(r => r.currentImageId).join(", "),
                                newDigest: updatedImages.map(r => r.newImageId).join(", "),
                                timestamp: dayjs().toISOString(),
                            });
                            await this.sendNotification("update_available", name, imageList);

                            const autoDeploy = await Settings.get("autoUpdateAutoDeploy");
                            if (autoDeploy && autoDeploy !== "false") {
                                this.isChecking = false;
                                await this.executeUpdate(name);
                                this.isChecking = true;
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
                    const tagSplit = service.image.split(":");
                    images.push({
                        image: service.image,
                        tag: tagSplit.length > 1 ? tagSplit[1] : "latest",
                    });
                }
            }
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to parse compose YAML: ${e.message}`);
            }
        }
        return images;
    }

    async getImageId(imageStr: string): Promise<string | null> {
        try {
            const res = await childProcessAsync.spawn("docker", [
                "image", "inspect",
                "--format", "{{.Id}}",
                imageStr,
            ], {
                encoding: "utf-8",
                timeout: 30000,
            });
            const id = res.stdout?.toString().trim();
            return id || null;
        } catch (e) {
            return null;
        }
    }

    async checkStackUpdate(stackName: string, stack: Stack): Promise<UpdateCheckResult[] | null> {
        try {
            const images = this.parseImagesFromCompose(stack.composeYAML);
            if (images.length === 0) {
                return null;
            }

            const beforeIds: Record<string, string | null> = {};
            for (const img of images) {
                beforeIds[img.image] = await this.getImageId(img.image);
            }

            try {
                await childProcessAsync.spawn("docker", stack.getComposeOptions("pull"), {
                    cwd: stack.path,
                    encoding: "utf-8",
                    timeout: 300000,
                });
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("auto-update", `docker compose pull failed for ${stackName}: ${e.message}`);
                }
            }

            const results: UpdateCheckResult[] = [];
            for (const img of images) {
                const afterId = await this.getImageId(img.image);
                const beforeId = beforeIds[img.image];
                const hasUpdate = !!(beforeId && afterId && beforeId !== afterId);

                results.push({
                    stackName,
                    image: img.image,
                    currentImageId: beforeId || "unknown",
                    newImageId: afterId || "unknown",
                    hasUpdate,
                    checkedAt: dayjs().toISOString(),
                });
            }

            return results;
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to check stack update for ${stackName}: ${e.message}`);
            }
            return null;
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

            const preUpdateIds = await this.captureImageIds(stack);

            await this.addUpdateLog({
                stackName,
                type: "update",
                status: "in_progress",
                message: `Starting update for stack ${stackName}`,
                timestamp: dayjs().toISOString(),
            });

            await this.savePreUpdateState(stackName, preUpdateIds);

            const pullRes = await childProcessAsync.spawn("docker", stack.getComposeOptions("pull"), {
                cwd: stack.path,
                encoding: "utf-8",
                timeout: 300000,
            });

            if (pullRes.code !== 0 && pullRes.code !== null) {
                throw new Error(`docker compose pull failed with code ${pullRes.code}`);
            }

            await stack.updateStatus();
            if (stack.status === 3) {
                const upRes = await childProcessAsync.spawn("docker", stack.getComposeOptions("up", "-d", "--remove-orphans"), {
                    cwd: stack.path,
                    encoding: "utf-8",
                    timeout: 300000,
                });

                if (upRes.code !== 0 && upRes.code !== null) {
                    throw new Error(`docker compose up failed with code ${upRes.code}`);
                }
            }

            const postUpdateIds = await this.captureImageIds(stack);

            await this.addUpdateLog({
                stackName,
                type: "update",
                status: "success",
                message: `Stack ${stackName} updated successfully`,
                oldDigest: JSON.stringify(preUpdateIds),
                newDigest: JSON.stringify(postUpdateIds),
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
                if (autoRollback && autoRollback !== "false") {
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

            const imageIds: Record<string, string> = JSON.parse(savedState);

            for (const [image, imageId] of Object.entries(imageIds)) {
                try {
                    await childProcessAsync.spawn("docker", [
                        "pull", `${image}@${imageId}`,
                    ], {
                        encoding: "utf-8",
                        timeout: 300000,
                    });
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("auto-update", `Could not pull old image for ${image}: ${e.message}`);
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

    protected async captureImageIds(stack: Stack): Promise<Record<string, string>> {
        const ids: Record<string, string> = {};
        const images = this.parseImagesFromCompose(stack.composeYAML);

        for (const imageInfo of images) {
            const id = await this.getImageId(imageInfo.image);
            if (id) {
                ids[imageInfo.image] = id;
            }
        }

        return ids;
    }

    protected async savePreUpdateState(stackName: string, ids: Record<string, string>) {
        await Settings.set(`autoUpdatePreState_${stackName}`, JSON.stringify(ids));
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

    protected async getExcludedStacks(): Promise<string[]> {
        try {
            const val = await Settings.get("autoUpdateExcludedStacks");
            if (!val) {
                return [];
            }
            if (Array.isArray(val)) {
                return val as string[];
            }
            if (typeof val === "string") {
                try {
                    const parsed = JSON.parse(val);
                    return Array.isArray(parsed) ? parsed : [];
                } catch (e) {
                    return [];
                }
            }
            return [];
        } catch (e) {
            return [];
        }
    }

    async getUpdateStatus(): Promise<Record<string, unknown>> {
        const enabled = await Settings.get("autoUpdateEnabled") || false;
        const checkInterval = parseInt(await Settings.get("autoUpdateCheckInterval") as string) || 60;
        const autoDeploy = await Settings.get("autoUpdateAutoDeploy") || false;
        const autoRollback = await Settings.get("autoUpdateAutoRollback") || false;
        const logRetentionDays = parseInt(await Settings.get("autoUpdateLogRetentionDays") as string) || 30;
        const excludedStacks = await this.getExcludedStacks();
        const notifications = await Settings.get("autoUpdateNotifications");
        const notificationsEnabled = notifications !== false && notifications !== "false";

        return {
            enabled: enabled === true || enabled === "true",
            checkInterval,
            autoDeploy: autoDeploy === true || autoDeploy === "true",
            autoRollback: autoRollback === true || autoRollback === "true",
            logRetentionDays,
            excludedStacks,
            notifications: notificationsEnabled,
            isChecking: this.isChecking,
            isUpdating: this.isUpdating,
        };
    }

    async saveUpdateSettings(settings: Record<string, unknown>) {
        const keyMap: Record<string, string> = {
            enabled: "autoUpdateEnabled",
            checkInterval: "autoUpdateCheckInterval",
            autoDeploy: "autoUpdateAutoDeploy",
            autoRollback: "autoUpdateAutoRollback",
            logRetentionDays: "autoUpdateLogRetentionDays",
            excludedStacks: "autoUpdateExcludedStacks",
            notifications: "autoUpdateNotifications",
        };

        for (const [frontendKey, backendKey] of Object.entries(keyMap)) {
            if (settings[frontendKey] !== undefined) {
                await Settings.set(backendKey, settings[frontendKey] as string | number | boolean | object);
            }
        }

        if (settings.enabled !== undefined || settings.checkInterval !== undefined) {
            await this.restart();
        }

        if (settings.logRetentionDays !== undefined) {
            await this.clearUpdateLogs(settings.logRetentionDays as number);
        }
    }

    protected async sendNotification(type: string, stackName: string, detail?: string) {
        try {
            const enabled = await Settings.get("autoUpdateNotifications");
            if (!enabled || enabled === "false") {
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
        const result = await this.checkStackUpdate(stackName, stack);
        return result || [];
    }
}
