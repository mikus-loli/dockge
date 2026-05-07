<template>
    <div>
        <!-- Status Dashboard -->
        <div class="mb-4">
            <h4 class="mb-3">
                <font-awesome-icon icon="tachometer-alt" class="me-2" />{{ $t("updateStatus") }}
            </h4>
            <div class="row g-3">
                <div class="col-md-6">
                    <div class="status-card">
                        <div class="status-label">{{ $t("currentVersion") }}</div>
                        <div class="status-value">
                            {{ status.currentVersion || "-" }}
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="status-card">
                        <div class="status-label">{{ $t("latestVersion") }}</div>
                        <div class="status-value">
                            <span v-if="status.updateAvailable" class="text-success">
                                {{ status.latestVersion }}
                                <span class="badge bg-success ms-1">{{ $t("New version available") }}</span>
                            </span>
                            <span v-else>{{ status.latestVersion || $t("sameAsLatest") }}</span>
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="status-card">
                        <div class="status-label">{{ $t("Last checked") }}</div>
                        <div class="status-value">
                            {{ status.lastCheck ? formatTime(status.lastCheck) : $t("never") }}
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="status-card">
                        <div class="status-label">{{ $t("updateRunningStatus") }}</div>
                        <div class="status-value">
                            <span v-if="status.isUpdating" class="text-warning">
                                <font-awesome-icon icon="spinner" spin class="me-1" />{{ $t("updating") }}
                            </span>
                            <span v-else-if="status.updateAvailable" class="text-success">
                                <font-awesome-icon icon="arrow-circle-up" class="me-1" />{{ $t("readyToUpdate") }}
                            </span>
                            <span v-else class="text-muted">
                                <font-awesome-icon icon="check-circle" class="me-1" />{{ $t("upToDate") }}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Last Error -->
            <div v-if="status.lastError" class="alert alert-danger mt-3">
                <font-awesome-icon icon="exclamation-triangle" class="me-2" />
                <strong>{{ $t("Last error") }}:</strong> {{ status.lastError }}
            </div>
        </div>

        <!-- Auto-Update Configuration -->
        <div class="mb-4">
            <h4 class="mb-3">
                <font-awesome-icon icon="cog" class="me-2" />{{ $t("Auto Update") }}
            </h4>

            <div class="mb-3">
                <div class="form-check form-switch">
                    <input
                        v-model="autoUpdateEnabled"
                        class="form-check-input"
                        type="checkbox"
                        role="switch"
                        @change="setAutoUpdate"
                    />
                    <label class="form-check-label">{{ $t("Enable Auto Update") }}</label>
                </div>
                <div class="form-text">
                    {{ $t("Automatically download and install updates when available") }}
                </div>
            </div>

            <div class="mb-3">
                <label class="form-label">{{ $t("Update Window") }}</label>
                <select v-model="autoUpdateWindow" class="form-select" @change="setAutoUpdateWindow">
                    <option value="any">{{ $t("Any time") }}</option>
                    <option value="0-6">{{ $t("Midnight to 6 AM") }}</option>
                    <option value="2-5">{{ $t("2 AM to 5 AM") }}</option>
                    <option value="1-4">{{ $t("1 AM to 4 AM") }}</option>
                </select>
                <div class="form-text">
                    {{ $t("updateWindowDesc") }}
                </div>
            </div>

            <!-- Action Buttons -->
            <div class="d-flex gap-2 flex-wrap">
                <button class="btn btn-primary" :disabled="checking" @click="checkForUpdate">
                    <font-awesome-icon v-if="checking" icon="spinner" spin class="me-1" />
                    <font-awesome-icon v-else icon="sync" class="me-1" />
                    {{ $t("Check Now") }}
                </button>
                <button
                    v-if="status.updateAvailable && !status.isUpdating"
                    class="btn btn-success"
                    :disabled="updating"
                    @click="performUpdate"
                >
                    <font-awesome-icon v-if="updating" icon="spinner" spin class="me-1" />
                    <font-awesome-icon v-else icon="rocket" class="me-1" />
                    {{ $t("Update Now") }}
                </button>
                <button
                    v-if="status.rollbackAvailable"
                    class="btn btn-warning"
                    :disabled="rollingBack"
                    @click="rollbackUpdate"
                >
                    <font-awesome-icon v-if="rollingBack" icon="spinner" spin class="me-1" />
                    <font-awesome-icon v-else icon="undo" class="me-1" />
                    {{ $t("Rollback") }}
                </button>
            </div>
        </div>

        <hr class="my-4" />

        <!-- Notification Settings -->
        <div class="mb-4">
            <h4 class="mb-3">
                <font-awesome-icon icon="bell" class="me-2" />{{ $t("notificationSettings") }}
            </h4>

            <!-- Browser Notifications -->
            <div class="card mb-3">
                <div class="card-body">
                    <h5 class="card-title">
                        <font-awesome-icon icon="desktop" class="me-2" />{{ $t("browserNotifications") }}
                    </h5>
                    <div class="form-check form-switch mb-2">
                        <input
                            v-model="notificationConfig.browser.enabled"
                            class="form-check-input"
                            type="checkbox"
                            role="switch"
                            @change="saveNotificationConfig"
                        />
                        <label class="form-check-label">{{ $t("enableBrowserNotifications") }}</label>
                    </div>
                    <div class="form-text">{{ $t("browserNotificationsDesc") }}</div>
                </div>
            </div>

            <!-- Webhook Notifications -->
            <div class="card mb-3">
                <div class="card-body">
                    <h5 class="card-title">
                        <font-awesome-icon icon="link" class="me-2" />{{ $t("webhookNotifications") }}
                    </h5>
                    <div class="form-check form-switch mb-2">
                        <input
                            v-model="notificationConfig.webhook.enabled"
                            class="form-check-input"
                            type="checkbox"
                            role="switch"
                            @change="saveNotificationConfig"
                        />
                        <label class="form-check-label">{{ $t("enableWebhook") }}</label>
                    </div>

                    <div v-if="notificationConfig.webhook.enabled">
                        <div class="mb-3">
                            <label class="form-label">{{ $t("webhookUrl") }}</label>
                            <input
                                v-model="notificationConfig.webhook.url"
                                type="url"
                                class="form-control"
                                placeholder="https://hooks.slack.com/services/..."
                                @change="saveNotificationConfig"
                            />
                        </div>
                        <div class="mb-3">
                            <label class="form-label">{{ $t("httpMethod") }}</label>
                            <select v-model="notificationConfig.webhook.method" class="form-select" @change="saveNotificationConfig">
                                <option value="POST">POST</option>
                                <option value="PUT">PUT</option>
                            </select>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">{{ $t("customHeaders") }}</label>
                            <textarea
                                v-model="webhookHeadersText"
                                class="form-control font-monospace"
                                rows="3"
                                placeholder='{"Authorization": "Bearer xxx"}'
                                @change="parseAndSaveHeaders"
                            ></textarea>
                            <div class="form-text">{{ $t("customHeadersDesc") }}</div>
                        </div>
                        <button class="btn btn-outline-secondary btn-sm" :disabled="testingWebhook" @click="testWebhook">
                            <font-awesome-icon v-if="testingWebhook" icon="spinner" spin class="me-1" />
                            <font-awesome-icon v-else icon="vial" class="me-1" />
                            {{ $t("testWebhook") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <hr class="my-4" />

        <!-- Update Logs -->
        <div class="mb-4">
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h4 class="mb-0">
                    <font-awesome-icon icon="history" class="me-2" />{{ $t("updateLogs") }}
                </h4>
                <div class="d-flex gap-2">
                    <select v-model="logFilter" class="form-select form-select-sm" style="width: auto;">
                        <option value="all">{{ $t("all") }}</option>
                        <option value="success">{{ $t("success") }}</option>
                        <option value="failed">{{ $t("failed") }}</option>
                        <option value="rolled_back">{{ $t("rolledBack") }}</option>
                    </select>
                    <button class="btn btn-outline-danger btn-sm" @click="clearLogs">
                        <font-awesome-icon icon="trash" class="me-1" />{{ $t("clearLogs") }}
                    </button>
                </div>
            </div>

            <div v-if="filteredLogs.length === 0" class="text-center text-muted py-4">
                <font-awesome-icon icon="inbox" class="me-1" />
                {{ $t("noUpdateLogs") }}
            </div>

            <div v-else class="table-responsive">
                <table class="table table-hover">
                    <thead>
                        <tr>
                            <th>{{ $t("Time") }}</th>
                            <th>{{ $t("Image") }}</th>
                            <th>{{ $t("Old Version") }}</th>
                            <th>{{ $t("New Version") }}</th>
                            <th>{{ $t("Status") }}</th>
                            <th>{{ $t("Duration") }}</th>
                            <th>{{ $t("Error") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="log in filteredLogs" :key="log.id">
                            <td class="text-nowrap">{{ formatTime(new Date(log.created_at).getTime()) }}</td>
                            <td class="text-truncate" style="max-width: 200px;" :title="log.image_name">
                                {{ log.image_name }}
                            </td>
                            <td>{{ log.old_version || "-" }}</td>
                            <td>{{ log.new_version || "-" }}</td>
                            <td>
                                <span :class="'badge bg-' + getStatusColor(log.status)">
                                    {{ $t(log.status) }}
                                </span>
                            </td>
                            <td>{{ log.duration_ms ? log.duration_ms + "ms" : "-" }}</td>
                            <td class="text-truncate" style="max-width: 200px;" :title="log.error_message">
                                {{ log.error_message || "-" }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <!-- Pagination -->
            <div v-if="logTotal > logPageSize" class="d-flex justify-content-center mt-3">
                <nav>
                    <ul class="pagination pagination-sm">
                        <li class="page-item" :class="{ disabled: logPage === 1 }">
                            <a class="page-link" href="#" @click.prevent="changeLogPage(logPage - 1)">&laquo;</a>
                        </li>
                        <li
                            v-for="p in totalPages"
                            :key="p"
                            class="page-item"
                            :class="{ active: p === logPage }"
                        >
                            <a class="page-link" href="#" @click.prevent="changeLogPage(p)">{{ p }}</a>
                        </li>
                        <li class="page-item" :class="{ disabled: logPage === totalPages }">
                            <a class="page-link" href="#" @click.prevent="changeLogPage(logPage + 1)">&raquo;</a>
                        </li>
                    </ul>
                </nav>
            </div>
        </div>
    </div>
</template>

<script>
import { useToast } from "vue-toastification";

export default {
    setup() {
        const toast = useToast();
        return { toast };
    },

    data() {
        return {
            status: {},
            autoUpdateEnabled: false,
            autoUpdateWindow: "any",
            checking: false,
            updating: false,
            rollingBack: false,
            testingWebhook: false,
            notificationConfig: {
                browser: {
                    enabled: true,
                    events: ["update_available", "update_success", "update_failed", "rollback_success", "rollback_failed"],
                },
                webhook: {
                    enabled: false,
                    url: "",
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    events: ["update_failed", "rollback_failed"],
                },
            },
            webhookHeadersText: '{"Content-Type": "application/json"}',
            updateLogs: [],
            logTotal: 0,
            logPage: 1,
            logPageSize: 20,
            logFilter: "all",
            socketListenerRegistered: false,
        };
    },

    computed: {
        filteredLogs() {
            if (this.logFilter === "all") {
                return this.updateLogs;
            }
            return this.updateLogs.filter((l) => l.status === this.logFilter);
        },

        totalPages() {
            return Math.ceil(this.logTotal / this.logPageSize) || 1;
        },
    },

    mounted() {
        this.fetchAutoUpdateStatus();
        this.fetchNotificationConfig();
        this.fetchUpdateLogs();
        this.registerSocketListeners();
    },

    unmounted() {
        if (this.socketListenerRegistered) {
            this.$root.getSocket().off("autoUpdateNotification");
            this.$root.getSocket().off("autoUpdateError");
        }
    },

    methods: {
        registerSocketListeners() {
            if (this.socketListenerRegistered) return;
            this.socketListenerRegistered = true;

            this.$root.getSocket().on("autoUpdateNotification", (data) => {
                if (data.event === "update_success") {
                    this.toast.success(this.$t("updateSuccessNotify", { version: data.newVersion }));
                    this.fetchAutoUpdateStatus();
                    this.fetchUpdateLogs();
                } else if (data.event === "update_failed") {
                    this.toast.error(this.$t("updateFailedNotify"));
                    this.fetchAutoUpdateStatus();
                    this.fetchUpdateLogs();
                } else if (data.event === "update_available") {
                    this.toast.info(this.$t("updateAvailableNotify", { version: data.newVersion }));
                    this.fetchAutoUpdateStatus();
                } else if (data.event === "rollback_success") {
                    this.toast.success(this.$t("rollbackSuccessNotify"));
                    this.fetchAutoUpdateStatus();
                    this.fetchUpdateLogs();
                } else if (data.event === "rollback_failed") {
                    this.toast.error(this.$t("rollbackFailedNotify"));
                    this.fetchUpdateLogs();
                }
            });

            this.$root.getSocket().on("autoUpdateError", (data) => {
                const msg = data.msgi18n ? this.$t(data.msg) : data.msg;
                this.toast.error(msg);
                this.fetchAutoUpdateStatus();
                this.fetchUpdateLogs();
            });
        },

        fetchAutoUpdateStatus() {
            this.$root.getSocket().emit("autoUpdateStatus", (res) => {
                if (res.ok) {
                    this.status = res.status;
                    this.autoUpdateEnabled = res.status.enabled;
                    this.autoUpdateWindow = res.status.updateWindow || "any";
                }
            });
        },

        fetchNotificationConfig() {
            this.$root.getSocket().emit("getNotificationConfig", (res) => {
                if (res.ok && res.config) {
                    this.notificationConfig = {
                        browser: { ...this.notificationConfig.browser, ...res.config.browser },
                        webhook: { ...this.notificationConfig.webhook, ...res.config.webhook },
                    };
                    try {
                        this.webhookHeadersText = JSON.stringify(this.notificationConfig.webhook.headers, null, 2);
                    } catch {
                        // ignore
                    }
                }
            });
        },

        fetchUpdateLogs() {
            this.$root.getSocket().emit("getUpdateLogs", {
                limit: this.logPageSize,
                offset: (this.logPage - 1) * this.logPageSize,
            }, (res) => {
                if (res.ok) {
                    this.updateLogs = res.logs;
                    this.logTotal = res.total;
                }
            });
        },

        setAutoUpdate() {
            this.$root.getSocket().emit("setAutoUpdate", this.autoUpdateEnabled, (res) => {
                this.$root.toastRes(res);
            });
        },

        setAutoUpdateWindow() {
            this.$root.getSocket().emit("setAutoUpdateWindow", this.autoUpdateWindow, (res) => {
                this.$root.toastRes(res);
            });
        },

        checkForUpdate() {
            this.checking = true;
            this.$root.getSocket().emit("checkForUpdate", (res) => {
                this.checking = false;
                if (res.ok) {
                    this.status.latestVersion = res.latestVersion;
                    this.status.updateAvailable = res.updateAvailable;
                    if (res.updateAvailable) {
                        this.toast.info(this.$t("updateAvailableNotify", { version: res.latestVersion }));
                    } else {
                        this.toast.success(this.$t("upToDate"));
                    }
                } else {
                    this.toast.error(res.msg);
                }
                this.status.lastCheck = Date.now();
            });
        },

        performUpdate() {
            if (!confirm(this.$t("confirmUpdate"))) return;
            this.updating = true;
            this.$root.getSocket().emit("performUpdate", (res) => {
                this.updating = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.status.isUpdating = true;
                }
            });
        },

        rollbackUpdate() {
            if (!confirm(this.$t("confirmRollback"))) return;
            this.rollingBack = true;
            this.$root.getSocket().emit("rollbackUpdate", (res) => {
                this.rollingBack = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.status.isUpdating = true;
                }
            });
        },

        saveNotificationConfig() {
            this.$root.getSocket().emit("setNotificationConfig", this.notificationConfig, (res) => {
                this.$root.toastRes(res);
            });
        },

        parseAndSaveHeaders() {
            try {
                const parsed = JSON.parse(this.webhookHeadersText);
                this.notificationConfig.webhook.headers = parsed;
                this.saveNotificationConfig();
            } catch {
                this.toast.error(this.$t("invalidJson"));
            }
        },

        testWebhook() {
            this.testingWebhook = true;
            this.$root.getSocket().emit("testWebhook", (res) => {
                this.testingWebhook = false;
                this.$root.toastRes(res);
            });
        },

        clearLogs() {
            if (!confirm(this.$t("confirmClearLogs"))) return;
            this.$root.getSocket().emit("clearUpdateLogs", {}, (res) => {
                if (res.ok) {
                    this.toast.success(this.$t("logsDeleted", { count: res.deleted }));
                    this.logPage = 1;
                    this.fetchUpdateLogs();
                }
            });
        },

        changeLogPage(page) {
            if (page < 1 || page > this.totalPages) return;
            this.logPage = page;
            this.fetchUpdateLogs();
        },

        formatTime(timestamp) {
            if (!timestamp) return "-";
            const d = new Date(timestamp);
            return d.toLocaleString();
        },

        getStatusColor(status) {
            switch (status) {
                case "success": return "success";
                case "failed": return "danger";
                case "rolled_back": return "warning";
                case "started": return "info";
                default: return "secondary";
            }
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../styles/vars.scss";

.status-card {
    background: rgba(0, 0, 0, 0.03);
    border-radius: 8px;
    padding: 12px 16px;

    .dark & {
        background: $dark-header-bg;
    }

    .status-label {
        font-size: 12px;
        color: $text-muted;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
    }

    .status-value {
        font-size: 16px;
        font-weight: 500;
    }
}

.card {
    border-radius: 10px;

    .dark & {
        background: $dark-header-bg;
        border-color: $dark-border-color;
    }
}

.table {
    font-size: 14px;

    th {
        font-weight: 600;
        white-space: nowrap;
    }
}
</style>
