import { log } from "./log";
import { Settings } from "./settings";
import type { DockgeServer } from "./dockge-server";

export type NotificationEventType =
    | "update_available"
    | "update_started"
    | "update_success"
    | "update_failed"
    | "rollback_success"
    | "rollback_failed"
    | "check_error";

export interface NotificationPayload {
    event: NotificationEventType;
    title: string;
    message: string;
    imageName?: string;
    targetType?: string;
    targetName?: string;
    oldVersion?: string;
    newVersion?: string;
    error?: string;
    timestamp: number;
}

export interface WebhookConfig {
    enabled: boolean;
    url: string;
    method: "POST" | "PUT";
    headers: Record<string, string>;
    events: NotificationEventType[];
}

export interface BrowserNotificationConfig {
    enabled: boolean;
    events: NotificationEventType[];
}

export interface NotificationConfig {
    webhook: WebhookConfig;
    browser: BrowserNotificationConfig;
}

const DEFAULT_CONFIG: NotificationConfig = {
    webhook: {
        enabled: false,
        url: "",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        events: ["update_failed", "rollback_failed"],
    },
    browser: {
        enabled: true,
        events: ["update_available", "update_success", "update_failed", "rollback_success", "rollback_failed"],
    },
};

class NotificationManager {
    private server: DockgeServer | null = null;

    async init(server: DockgeServer) {
        this.server = server;
    }

    async getConfig(): Promise<NotificationConfig> {
        const saved = await Settings.get("notificationConfig");
        if (saved && typeof saved === "object") {
            return {
                webhook: { ...DEFAULT_CONFIG.webhook, ...(saved as NotificationConfig).webhook },
                browser: { ...DEFAULT_CONFIG.browser, ...(saved as NotificationConfig).browser },
            };
        }
        return { ...DEFAULT_CONFIG };
    }

    async setConfig(config: Partial<NotificationConfig>): Promise<void> {
        const current = await this.getConfig();
        const merged: NotificationConfig = {
            webhook: { ...current.webhook, ...config.webhook },
            browser: { ...current.browser, ...config.browser },
        };
        await Settings.set("notificationConfig", merged);
    }

    async send(payload: NotificationPayload): Promise<void> {
        const config = await this.getConfig();

        log.info("notification", `[${payload.event}] ${payload.title}: ${payload.message}`);

        const promises: Promise<void>[] = [];

        if (config.webhook.enabled && config.webhook.events.includes(payload.event)) {
            promises.push(this.sendWebhook(config.webhook, payload));
        }

        if (config.browser.enabled && config.browser.events.includes(payload.event)) {
            promises.push(this.sendBrowserNotification(payload));
        }

        await Promise.allSettled(promises);
    }

    private async sendWebhook(webhookConfig: WebhookConfig, payload: NotificationPayload): Promise<void> {
        if (!webhookConfig.url) {
            log.warn("notification", "Webhook URL not configured, skipping webhook notification");
            return;
        }

        try {
            const body = JSON.stringify({
                event: payload.event,
                title: payload.title,
                message: payload.message,
                image: payload.imageName,
                target: payload.targetName,
                targetType: payload.targetType,
                oldVersion: payload.oldVersion,
                newVersion: payload.newVersion,
                error: payload.error,
                timestamp: new Date(payload.timestamp).toISOString(),
                source: "dockge",
            });

            const headers: Record<string, string> = {
                ...webhookConfig.headers,
            };

            const res = await fetch(webhookConfig.url, {
                method: webhookConfig.method,
                headers,
                body,
                signal: AbortSignal.timeout(10000),
            });

            if (!res.ok) {
                log.error("notification", `Webhook request failed with status ${res.status}: ${await res.text()}`);
            } else {
                log.debug("notification", `Webhook notification sent successfully to ${webhookConfig.url}`);
            }
        } catch (e) {
            log.error("notification", `Failed to send webhook notification: ${e}`);
        }
    }

    private async sendBrowserNotification(payload: NotificationPayload): Promise<void> {
        if (!this.server) {
            return;
        }

        try {
            this.server.io.emit("autoUpdateNotification", {
                event: payload.event,
                title: payload.title,
                message: payload.message,
                imageName: payload.imageName,
                oldVersion: payload.oldVersion,
                newVersion: payload.newVersion,
                timestamp: payload.timestamp,
            });
        } catch (e) {
            log.error("notification", `Failed to send browser notification: ${e}`);
        }
    }
}

const notificationManager = new NotificationManager();
export default notificationManager;
