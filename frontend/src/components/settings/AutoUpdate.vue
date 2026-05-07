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
                    <input id="whitelistMode" v-model="autoUpdateSettings.whitelistMode" class="form-check-input" type="checkbox" />
                    <label class="form-check-label" for="whitelistMode">
                        {{ $t("autoUpdateWhitelistMode") }}
                    </label>
                </div>
                <div class="form-text">{{ $t("autoUpdateWhitelistModeDescription") }}</div>
            </div>

            <div v-if="autoUpdateSettings.enabled && autoUpdateSettings.whitelistMode" class="mb-4">
                <label class="form-label">{{ $t("autoUpdateWhitelist") }}</label>
                <div class="stack-tag-area">
                    <span v-for="stack in autoUpdateSettings.whitelist" :key="stack" class="stack-tag">
                        {{ stack }}
                        <button type="button" class="stack-tag-remove" @click="removeFromList('whitelist', stack)">&times;</button>
                    </span>
                    <span v-if="autoUpdateSettings.whitelist.length === 0" class="text-muted stack-tag-empty">{{ $t("autoUpdateNoStacksSelected") }}</span>
                </div>
                <select v-if="availableWhitelistStacks.length > 0" class="form-select form-select-sm stack-add-select" @change="addToList('whitelist', $event)">
                    <option value="">{{ $t("autoUpdateAddStack") }}</option>
                    <option v-for="stack in availableWhitelistStacks" :key="stack" :value="stack">{{ stack }}</option>
                </select>
                <div class="form-text">{{ $t("autoUpdateWhitelistDescription") }}</div>
            </div>

            <div v-if="autoUpdateSettings.enabled && !autoUpdateSettings.whitelistMode" class="mb-4">
                <label class="form-label">{{ $t("autoUpdateExcludedStacks") }}</label>
                <div class="stack-tag-area">
                    <span v-for="stack in autoUpdateSettings.excludedStacks" :key="stack" class="stack-tag">
                        {{ stack }}
                        <button type="button" class="stack-tag-remove" @click="removeFromList('excludedStacks', stack)">&times;</button>
                    </span>
                    <span v-if="autoUpdateSettings.excludedStacks.length === 0" class="text-muted stack-tag-empty">{{ $t("autoUpdateNoStacksSelected") }}</span>
                </div>
                <select v-if="availableExcludedStacks.length > 0" class="form-select form-select-sm stack-add-select" @change="addToList('excludedStacks', $event)">
                    <option value="">{{ $t("autoUpdateAddStack") }}</option>
                    <option v-for="stack in availableExcludedStacks" :key="stack" :value="stack">{{ stack }}</option>
                </select>
                <div class="form-text">{{ $t("autoUpdateExcludedStacksDescription") }}</div>
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

            <div v-if="autoUpdateSettings.enabled" class="mb-4">
                <div class="form-check form-switch">
                    <input id="miotifyEnabled" v-model="autoUpdateSettings.miotifyEnabled" class="form-check-input" type="checkbox" />
                    <label class="form-check-label" for="miotifyEnabled">
                        {{ $t("autoUpdateMiotifyEnabled") }}
                    </label>
                </div>
                <div class="form-text">{{ $t("autoUpdateMiotifyEnabledDescription") }}</div>
            </div>

            <div v-if="autoUpdateSettings.enabled && autoUpdateSettings.miotifyEnabled" class="mb-4">
                <div class="mb-3">
                    <label class="form-label" for="miotifyUrl">{{ $t("autoUpdateMiotifyUrl") }}</label>
                    <input id="miotifyUrl" v-model="autoUpdateSettings.miotifyUrl" class="form-control" type="url" placeholder="https://miotify.example.com" />
                    <div class="form-text">{{ $t("autoUpdateMiotifyUrlDescription") }}</div>
                </div>
                <div class="mb-3">
                    <label class="form-label" for="miotifyToken">{{ $t("autoUpdateMiotifyToken") }}</label>
                    <input id="miotifyToken" v-model="autoUpdateSettings.miotifyToken" class="form-control" type="password" placeholder="App Token" />
                    <div class="form-text">{{ $t("autoUpdateMiotifyTokenDescription") }}</div>
                </div>
                <button type="button" class="btn btn-outline-primary" :disabled="testingNotif" @click="testNotification">
                    <span v-if="testingNotif" class="spinner-border spinner-border-sm me-1"></span>
                    {{ $t("autoUpdateTestNotification") }}
                </button>
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
                whitelistMode: false,
                whitelist: [],
                miotifyEnabled: false,
                miotifyUrl: "",
                miotifyToken: "",
            },
            logs: [],
            logFilter: "",
            saving: false,
            checking: false,
            testingNotif: false,
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
        availableWhitelistStacks() {
            return this.stackList.filter(s => !this.autoUpdateSettings.whitelist.includes(s));
        },
        availableExcludedStacks() {
            return this.stackList.filter(s => !this.autoUpdateSettings.excludedStacks.includes(s));
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
        addToList(listKey, event) {
            const value = event.target.value;
            if (!value) return;
            const list = this.autoUpdateSettings[listKey];
            if (!list.includes(value)) {
                list.push(value);
            }
            event.target.value = "";
        },

        removeFromList(listKey, stack) {
            const list = this.autoUpdateSettings[listKey];
            const idx = list.indexOf(stack);
            if (idx !== -1) {
                list.splice(idx, 1);
            }
        },

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
                        whitelistMode: res.data.whitelistMode || false,
                        whitelist: res.data.whitelist || [],
                        miotifyEnabled: res.data.miotifyEnabled || false,
                        miotifyUrl: res.data.miotifyUrl || "",
                        miotifyToken: res.data.miotifyToken || "",
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

        testNotification() {
            this.testingNotif = true;
            this.$root.getSocket().emit("autoUpdateTestNotification", (res) => {
                this.testingNotif = false;
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

    .dark & {
        color: $dark-font-color;
        --bs-table-bg: transparent;
        --bs-table-color: #{$dark-font-color};
        --bs-table-border-color: #{$dark-border-color};
        --bs-table-striped-bg: rgba(255, 255, 255, 0.02);
        --bs-table-hover-bg: rgba(255, 255, 255, 0.04);
    }
}

.table-responsive {
    .dark & {
        border-color: $dark-border-color;
    }
}

.stack-tag-area {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 32px;
    padding: 6px 8px;
    border: 1px solid $border-light;
    border-radius: 6px;
    margin-bottom: 6px;
    align-items: center;

    .dark & {
        border-color: $dark-border-color;
        background-color: rgba(255, 255, 255, 0.03);
    }
}

.stack-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.85rem;
    background-color: rgba($primary, 0.12);
    color: $primary;
    white-space: nowrap;

    .dark & {
        background-color: rgba($primary, 0.2);
    }
}

.stack-tag-remove {
    background: none;
    border: none;
    padding: 0 2px;
    font-size: 1rem;
    line-height: 1;
    color: inherit;
    opacity: 0.6;
    cursor: pointer;

    &:hover {
        opacity: 1;
    }
}

.stack-tag-empty {
    font-size: 0.85rem;
}

.stack-add-select {
    max-width: 220px;
}
</style>
