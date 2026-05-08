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

            const whitelistMode = await this.getSettingBool("autoUpdateWhitelistMode");
            const whitelist = await this.getStringList("autoUpdateWhitelist");
            const excludedStacks = await this.getStringList("autoUpdateExcludedStacks");
            const stackList = await Stack.getStackList(this.server, true);
            const allResults: UpdateCheckResult[] = [];

            for (const [name, stack] of stackList) {
                if (!stack.isManagedByDockge) {
                    continue;
                }

                if (whitelistMode && whitelist.length > 0 && !whitelist.includes(name)) {
                    log.debug("auto-update", `Skipping non-whitelisted stack: ${name}`);
                    continue;
                }

                if (!whitelistMode && excludedStacks.includes(name)) {
                    log.debug("auto-update", `Skipping excluded stack: ${name}`);
                    continue;
                }

                try {
                    const { results: checkResults, preUpdateIds } = await this.checkStackUpdate(name, stack);
                    if (checkResults) {
                        const updatedImages = checkResults.filter(r => r.hasUpdate);
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
                                await this.executeUpdate(name, true, preUpdateIds);
                                this.isChecking = true;
                            }
                        }

                        allResults.push(...checkResults);
                    }
                } catch (e) {
                    if (e instanceof Error) {
                        log.error("auto-update", `Error checking stack ${name}: ${e.message}`);
                    }
                }
            }

            this.server.io.emit("autoUpdateCheckResult", allResults);
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

    async getImageRepoDigest(imageStr: string): Promise<string | null> {
        try {
            const res = await childProcessAsync.spawn("docker", [
                "image", "inspect",
                "--format", "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}",
                imageStr,
            ], {
                encoding: "utf-8",
                timeout: 30000,
            });
            const output = res.stdout?.toString().trim();
            if (output && output.includes("@")) {
                return output.split("@")[1];
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    async checkStackUpdate(stackName: string, stack: Stack): Promise<{ results: UpdateCheckResult[] | null; preUpdateIds: Record<string, string> }> {
        try {
            const images = this.parseImagesFromCompose(stack.composeYAML);
            if (images.length === 0) {
                return { results: null, preUpdateIds: {} };
            }

            const beforeIds: Record<string, string | null> = {};
            const preUpdateIds: Record<string, string> = {};
            for (const img of images) {
                const id = await this.getImageId(img.image);
                beforeIds[img.image] = id;
                const repoDigest = await this.getImageRepoDigest(img.image);
                if (repoDigest) {
                    preUpdateIds[img.image] = repoDigest;
                } else if (id) {
                    preUpdateIds[img.image] = id;
                }
            }

            let pullFailed = false;
            try {
                const pullRes = await childProcessAsync.spawn("docker", stack.getComposeOptions("pull"), {
                    cwd: stack.path,
                    encoding: "utf-8",
                    timeout: 300000,
                });

                if (pullRes.code !== 0 && pullRes.code !== null) {
                    pullFailed = true;
                    log.warn("auto-update", `docker compose pull failed for ${stackName} with code ${pullRes.code}`);
                }
            } catch (e) {
                pullFailed = true;
                if (e instanceof Error) {
                    log.warn("auto-update", `docker compose pull failed for ${stackName}: ${e.message}`);
                }
            }

            if (pullFailed) {
                await this.addUpdateLog({
                    stackName,
                    type: "check",
                    status: "failed",
                    message: `Failed to pull images for stack ${stackName}`,
                    timestamp: dayjs().toISOString(),
                });
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

            return { results, preUpdateIds };
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to check stack update for ${stackName}: ${e.message}`);
            }
            return { results: null, preUpdateIds: {} };
        }
    }

    async executeUpdate(stackName: string, skipPull = false, preUpdateIdsFromCheck?: Record<string, string>): Promise<boolean> {
        if (this.isUpdating) {
            log.warn("auto-update", "Another update is in progress, skipping");
            return false;
        }

        this.isUpdating = true;
        try {
            const stack = await Stack.getStack(this.server, stackName);

            const preUpdateIds = preUpdateIdsFromCheck || await this.captureImageIds(stack);

            await this.addUpdateLog({
                stackName,
                type: "update",
                status: "in_progress",
                message: `Starting update for stack ${stackName}`,
                timestamp: dayjs().toISOString(),
            });

            await this.savePreUpdateState(stackName, preUpdateIds);

            if (!skipPull) {
                const pullRes = await childProcessAsync.spawn("docker", stack.getComposeOptions("pull"), {
                    cwd: stack.path,
                    encoding: "utf-8",
                    timeout: 300000,
                });

                if (pullRes.code !== 0 && pullRes.code !== null) {
                    throw new Error(`docker compose pull failed with code ${pullRes.code}`);
                }
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
            } else {
                log.info("auto-update", `Stack ${stackName} is not running, skipping restart. Images have been pulled.`);
            }

            const postUpdateIds = await this.captureImageIds(stack);

            await this.addUpdateLog({
                stackName,
                type: "update",
                status: "success",
                message: wasRunning
                    ? `Stack ${stackName} updated and restarted successfully`
                    : `Stack ${stackName} images pulled successfully (stack was not running)`,
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

            for (const [image, digest] of Object.entries(imageIds)) {
                try {
                    await childProcessAsync.spawn("docker", [
                        "pull", `${image}@${digest}`,
                    ], {
                        encoding: "utf-8",
                        timeout: 300000,
                    });

                    const inspectRes = await childProcessAsync.spawn("docker", [
                        "image", "inspect",
                        "--format", "{{.Id}}",
                        `${image}@${digest}`,
                    ], {
                        encoding: "utf-8",
                        timeout: 30000,
                    });

                    const oldImageId = inspectRes.stdout?.toString().trim();
                    if (!oldImageId) {
                        log.warn("auto-update", `Could not get ID for old image ${image}@${digest}`);
                        continue;
                    }

                    await childProcessAsync.spawn("docker", [
                        "tag", "--force", oldImageId, image,
                    ], {
                        encoding: "utf-8",
                        timeout: 30000,
                    });

                    log.info("auto-update", `Retagged ${image} to old version ${digest}`);
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("auto-update", `Could not rollback image ${image}: ${e.message}`);
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
            const repoDigest = await this.getImageRepoDigest(imageInfo.image);
            if (repoDigest) {
                ids[imageInfo.image] = repoDigest;
            } else {
                const id = await this.getImageId(imageInfo.image);
                if (id) {
                    ids[imageInfo.image] = id;
                }
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
            bean.stack_name = entry.stackName;
            bean.type = entry.type;
            bean.status = entry.status;
            bean.message = entry.message;
            bean.old_digest = entry.oldDigest || "";
            bean.new_digest = entry.newDigest || "";
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
                query = query.where("stack_name", stackName);
            }
            const rows = await query;
            return rows.map((row: Record<string, unknown>) => ({
                id: row.id as number,
                stackName: row.stack_name as string,
                type: row.type as UpdateLogEntry["type"],
                status: row.status as UpdateLogEntry["status"],
                message: row.message as string,
                oldDigest: (row.old_digest as string) || "",
                newDigest: (row.new_digest as string) || "",
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
            const result = await R.exec("DELETE FROM update_log WHERE timestamp < ?", [cutoff]);
            log.info("auto-update", `Cleared update logs older than ${beforeDays} days`);
            return result;
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to clear update logs: ${e.message}`);
            }
            return 0;
        }
    }

    async clearAllUpdateLogs() {
        try {
            const result = await R.exec("DELETE FROM update_log");
            log.info("auto-update", "Cleared all update logs");
            return result;
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to clear all update logs: ${e.message}`);
            }
            return 0;
        }
    }

    protected async getSettingBool(key: string): Promise<boolean> {
        const val = await Settings.get(key);
        return val === true || val === "true";
    }

    protected async getStringList(key: string): Promise<string[]> {
        try {
            const val = await Settings.get(key);
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
        const enabled = await this.getSettingBool("autoUpdateEnabled");
        const checkInterval = parseInt(await Settings.get("autoUpdateCheckInterval") as string) || 60;
        const autoDeploy = await this.getSettingBool("autoUpdateAutoDeploy");
        const autoRollback = await this.getSettingBool("autoUpdateAutoRollback");
        const logRetentionDays = parseInt(await Settings.get("autoUpdateLogRetentionDays") as string) || 30;
        const excludedStacks = await this.getStringList("autoUpdateExcludedStacks");
        const notifications = await this.getSettingBool("autoUpdateNotifications");
        const whitelistMode = await this.getSettingBool("autoUpdateWhitelistMode");
        const whitelist = await this.getStringList("autoUpdateWhitelist");
        const miotifyUrl = (await Settings.get("autoUpdateMiotifyUrl") as string) || "";
        const miotifyToken = (await Settings.get("autoUpdateMiotifyToken") as string) || "";
        const miotifyEnabled = await this.getSettingBool("autoUpdateMiotifyEnabled");

        return {
            enabled,
            checkInterval,
            autoDeploy,
            autoRollback,
            logRetentionDays,
            excludedStacks,
            notifications,
            whitelistMode,
            whitelist,
            miotifyEnabled,
            miotifyUrl,
            miotifyToken,
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
            whitelistMode: "autoUpdateWhitelistMode",
            whitelist: "autoUpdateWhitelist",
            miotifyEnabled: "autoUpdateMiotifyEnabled",
            miotifyUrl: "autoUpdateMiotifyUrl",
            miotifyToken: "autoUpdateMiotifyToken",
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
            const enabled = await this.getSettingBool("autoUpdateNotifications");
            if (!enabled) {
                return;
            }

            this.server.io.emit("autoUpdateNotification", {
                type,
                stackName,
                detail,
                timestamp: dayjs().toISOString(),
            });

            await this.sendMiotifyNotification(type, stackName, detail);
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Failed to send notification: ${e.message}`);
            }
        }
    }

    protected async sendMiotifyNotification(type: string, stackName: string, detail?: string) {
        try {
            const miotifyEnabled = await this.getSettingBool("autoUpdateMiotifyEnabled");
            if (!miotifyEnabled) {
                return;
            }

            const miotifyUrl = await Settings.get("autoUpdateMiotifyUrl") as string;
            const miotifyToken = await Settings.get("autoUpdateMiotifyToken") as string;

            if (!miotifyUrl || !miotifyToken) {
                log.warn("auto-update", "Miotify URL or Token not configured, skipping notification");
                return;
            }

            const titleMap: Record<string, string> = {
                update_available: "📦 Update Available",
                update_success: "✅ Update Success",
                update_failed: "❌ Update Failed",
                rollback_success: "🔄 Rollback Success",
                rollback_failed: "⚠️ Rollback Failed",
                test: "🔔 Test Notification",
            };

            const title = titleMap[type] || type;
            const message = detail
                ? `${stackName}: ${detail}`
                : stackName;

            const priorityMap: Record<string, number> = {
                update_available: 5,
                update_success: 3,
                update_failed: 8,
                rollback_success: 5,
                rollback_failed: 9,
                test: 5,
            };

            const baseUrl = miotifyUrl.replace(/\/+$/, "");
            const url = `${baseUrl}/message`;

            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Gotify-Key": miotifyToken,
                },
                body: JSON.stringify({
                    title,
                    message,
                    priority: priorityMap[type] || 5,
                }),
            });

            if (!res.ok) {
                log.warn("auto-update", `Miotify notification failed: ${res.status} ${res.statusText}`);
            } else {
                log.debug("auto-update", `Miotify notification sent: ${type} for ${stackName}`);
            }
        } catch (e) {
            if (e instanceof Error) {
                log.warn("auto-update", `Miotify notification error: ${e.message}`);
            }
        }
    }

    async checkSingleStack(stackName: string): Promise<UpdateCheckResult[]> {
        const stack = await Stack.getStack(this.server, stackName);
        const { results } = await this.checkStackUpdate(stackName, stack);
        return results || [];
    }

    async sendTestNotification(): Promise<boolean> {
        try {
            await this.sendMiotifyNotification("test", "Dockge", "Test notification from Dockge auto-update");
            return true;
        } catch (e) {
            if (e instanceof Error) {
                log.error("auto-update", `Test notification failed: ${e.message}`);
            }
            return false;
        }
    }
}
