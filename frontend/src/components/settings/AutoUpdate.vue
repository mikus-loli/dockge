<template>
    <div>
        <form class="my-4" autocomplete="off" @submit.prevent="saveSettings">
            <div class="mb-4">
                <div class="form-check form-switch">
                    <input id="autoUpdateEnabled" v-model="autoUpdateSettings.enabled" class="form-check-input" type="checkbox" />
                    <label class="form-check-label" for="autoUpdateEnabled">
                        {{ $t("autoUpdateEnabled") }}
                    </label>
                </div>
                <div class="form-text">{{ $t("autoUpdateEnabledDescription") }}</div>
            </div>

            <div v-if="autoUpdateSettings.enabled" class="mb-4">
                <label class="form-label" for="checkInterval">
                    {{ $t("autoUpdateCheckInterval") }}
                </label>
                <div class="input-group mb-3">
                    <input id="checkInterval" v-model.number="autoUpdateSettings.checkInterval" class="form-control" type="number" min="5" max="1440" />
                    <span class="input-group-text">{{ $t("minutes") }}</span>
                </div>
                <div class="form-text">{{ $t("autoUpdateCheckIntervalDescription") }}</div>
            </div>

            <div v-if="autoUpdateSettings.enabled" class="mb-4">
                <div class="form-check form-switch">
                    <input id="autoDeploy" v-model="autoUpdateSettings.autoDeploy" class="form-check-input" type="checkbox" />
                    <label class="form-check-label" for="autoDeploy">
                        {{ $t("autoUpdateAutoDeploy") }}
                    </label>
                </div>
                <div class="form-text">{{ $t("autoUpdateAutoDeployDescription") }}</div>
            </div>

            <div v-if="autoUpdateSettings.enabled" class="mb-4">
                <div class="form-check form-switch">
                    <input id="autoRollback" v-model="autoUpdateSettings.autoRollback" class="form-check-input" type="checkbox" />
                    <label class="form-check-label" for="autoRollback">
                        {{ $t("autoUpdateAutoRollback") }}
                    </label>
                </div>
                <div class="form-text">{{ $t("autoUpdateAutoRollbackDescription") }}</div>
            </div>

            <div v-if="autoUpdateSettings.enabled" class="mb-4">
                <label class="form-label" for="logRetention">
                    {{ $t("autoUpdateLogRetentionDays") }}
                </label>
                <div class="input-group mb-3">
                    <input id="logRetention" v-model.number="autoUpdateSettings.logRetentionDays" class="form-control" type="number" min="1" max="365" />
                    <span class="input-group-text">{{ $t("days") }}</span>
                </div>
            </div>

            <div v-if="autoUpdateSettings.enabled" class="mb-4">
                <div class="form-check form-switch">
                    <input id="notifications" v-model="autoUpdateSettings.notifications" class="form-check-input" type="checkbox" />
                    <label class="form-check-label" for="notifications">
                        {{ $t("autoUpdateNotifications") }}
                    </label>
                </div>
                <div class="form-text">{{ $t("autoUpdateNotificationsDescription") }}</div>
            </div>

            <div class="mb-4">
                <button class="btn btn-primary me-2" type="submit" :disabled="saving">
                    <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>
                    {{ $t("Save") }}
                </button>
                <button v-if="autoUpdateSettings.enabled" class="btn btn-outline-primary me-2" type="button" :disabled="checking" @click="checkNow">
                    <span v-if="checking" class="spinner-border spinner-border-sm me-1"></span>
                    {{ $t("autoUpdateCheckNow") }}
                </button>
            </div>
        </form>

        <h5 class="settings-subheading">{{ $t("autoUpdateLogs") }}</h5>

        <div class="mb-3">
            <div class="input-group">
                <select v-model="logFilter" class="form-select" style="max-width: 200px" @change="loadLogs">
                    <option value="">{{ $t("All Stacks") }}</option>
                    <option v-for="stack in stackList" :key="stack" :value="stack">{{ stack }}</option>
                </select>
                <button class="btn btn-outline-danger" type="button" @click="clearLogs">
                    {{ $t("autoUpdateClearLogs") }}
                </button>
            </div>
        </div>

        <div v-if="logs.length === 0" class="text-muted mt-3">
            {{ $t("autoUpdateNoLogs") }}
        </div>

        <div v-else class="table-responsive">
            <table class="table table-sm">
                <thead>
                    <tr>
                        <th>{{ $t("autoUpdateLogTime") }}</th>
                        <th>{{ $t("autoUpdateLogStack") }}</th>
                        <th>{{ $t("autoUpdateLogType") }}</th>
                        <th>{{ $t("autoUpdateLogStatus") }}</th>
                        <th>{{ $t("autoUpdateLogMessage") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="log in logs" :key="log.id">
                        <td>{{ formatTime(log.timestamp) }}</td>
                        <td>{{ log.stackName }}</td>
                        <td>
                            <span :class="typeClass(log.type)">{{ typeLabel(log.type) }}</span>
                        </td>
                        <td>
                            <span :class="statusClass(log.status)">{{ statusLabel(log.status) }}</span>
                        </td>
                        <td>{{ log.message }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<script>
import dayjs from "dayjs";

export default {
    data() {
        return {
            autoUpdateSettings: {
                enabled: false,
                checkInterval: 60,
                autoDeploy: false,
                autoRollback: false,
                logRetentionDays: 30,
                notifications: true,
                excludedStacks: [],
            },
            logs: [],
            logFilter: "",
            saving: false,
            checking: false,
        };
    },

    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
        stackList() {
            if (this.$root.stackList) {
                return Object.keys(this.$root.stackList);
            }
            return [];
        },
    },

    watch: {
        settingsLoaded(val) {
            if (val) {
                this.loadStatus();
            }
        },
    },

    mounted() {
        if (this.settingsLoaded) {
            this.loadStatus();
        }
        this.loadLogs();

        this.$root.getSocket().on("autoUpdateNotification", (data) => {
            this.handleNotification(data);
        });
    },

    beforeUnmount() {
        this.$root.getSocket().off("autoUpdateNotification");
    },

    methods: {
        loadStatus() {
            this.$root.getSocket().emit("autoUpdateGetStatus", (res) => {
                if (res.ok) {
                    this.autoUpdateSettings = {
                        enabled: res.data.enabled || false,
                        checkInterval: res.data.checkInterval || 60,
                        autoDeploy: res.data.autoDeploy || false,
                        autoRollback: res.data.autoRollback || false,
                        logRetentionDays: res.data.logRetentionDays || 30,
                        notifications: res.data.notifications !== false,
                        excludedStacks: res.data.excludedStacks || [],
                    };
                }
            });
        },

        saveSettings() {
            this.saving = true;
            this.$root.getSocket().emit("autoUpdateSaveSettings", this.autoUpdateSettings, (res) => {
                this.saving = false;
                if (res.ok) {
                    this.$root.toastRes(res);
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },

        checkNow() {
            this.checking = true;
            this.$root.getSocket().emit("autoUpdateCheckNow", (res) => {
                this.checking = false;
                if (res.ok) {
                    this.$root.toastRes(res);
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },

        loadLogs() {
            this.$root.getSocket().emit("autoUpdateGetLogs", this.logFilter || null, 100, (res) => {
                if (res.ok) {
                    this.logs = res.logs;
                }
            });
        },

        clearLogs() {
            this.$root.getSocket().emit("autoUpdateClearLogs", this.autoUpdateSettings.logRetentionDays, (res) => {
                if (res.ok) {
                    this.$root.toastRes(res);
                    this.loadLogs();
                }
            });
        },

        formatTime(timestamp) {
            return dayjs(timestamp).format("YYYY-MM-DD HH:mm:ss");
        },

        typeLabel(type) {
            const map = {
                check: this.$t("autoUpdateTypeCheck"),
                update: this.$t("autoUpdateTypeUpdate"),
                rollback: this.$t("autoUpdateTypeRollback"),
                error: this.$t("autoUpdateTypeError"),
            };
            return map[type] || type;
        },

        typeClass(type) {
            const map = {
                check: "text-info",
                update: "text-primary",
                rollback: "text-warning",
                error: "text-danger",
            };
            return map[type] || "";
        },

        statusLabel(status) {
            const map = {
                success: this.$t("autoUpdateStatusSuccess"),
                failed: this.$t("autoUpdateStatusFailed"),
                in_progress: this.$t("autoUpdateStatusInProgress"),
            };
            return map[status] || status;
        },

        statusClass(status) {
            const map = {
                success: "text-success",
                failed: "text-danger",
                in_progress: "text-warning",
            };
            return map[status] || "";
        },

        handleNotification(data) {
            const msgMap = {
                update_available: `${data.stackName}: ${this.$t("autoUpdateNotifAvailable")}`,
                update_success: `${data.stackName}: ${this.$t("autoUpdateNotifSuccess")}`,
                update_failed: `${data.stackName}: ${this.$t("autoUpdateNotifFailed")} - ${data.detail}`,
                rollback_success: `${data.stackName}: ${this.$t("autoUpdateNotifRollbackSuccess")}`,
                rollback_failed: `${data.stackName}: ${this.$t("autoUpdateNotifRollbackFailed")} - ${data.detail}`,
            };

            const msg = msgMap[data.type] || `${data.stackName}: ${data.type}`;

            if (data.type.includes("failed")) {
                this.$root.toastError(msg);
            } else {
                this.$root.toastSuccess(msg);
            }

            this.loadLogs();
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../styles/vars.scss";

.settings-subheading {
    border-bottom: 1px solid $border-light;
    padding-bottom: 8px;
    margin-bottom: 16px;
    margin-top: 24px;

    .dark & {
        border-bottom-color: $dark-border-color;
    }
}

.table {
    font-size: 0.85rem;

    th, td {
        padding: 0.4rem 0.6rem;
        vertical-align: middle;
    }
}
</style>
