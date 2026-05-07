<template>
    <div>
        <div class="my-4">
            <h5 class="mb-3">
                <font-awesome-icon icon="arrows-rotate" />
                {{ $t("Auto Update Settings") }}
            </h5>

            <div class="mb-4">
                <label class="form-check-label">
                    <input
                        v-model="config.enabled"
                        class="form-check-input me-2"
                        type="checkbox"
                    />
                    {{ $t("Enable Auto Update") }}
                </label>
                <div class="form-text">
                    {{ $t("autoUpdateEnabledDesc") }}
                </div>
            </div>

            <div class="mb-4">
                <label class="form-label">
                    {{ $t("Update Schedule") }}
                </label>
                <input
                    v-model="config.schedule"
                    class="form-control"
                    placeholder="0 4 * * *"
                />
                <div class="form-text">
                    {{ $t("autoUpdateScheduleDesc") }}
                </div>
            </div>

            <div class="mb-4">
                <label class="form-check-label">
                    <input
                        v-model="config.pruneImages"
                        class="form-check-input me-2"
                        type="checkbox"
                    />
                    {{ $t("Prune Unused Images") }}
                </label>
                <div class="form-text">
                    {{ $t("autoUpdatePruneDesc") }}
                </div>
            </div>

            <div class="mb-4">
                <label class="form-check-label">
                    <input
                        v-model="config.notifyOnUpdate"
                        class="form-check-input me-2"
                        type="checkbox"
                    />
                    {{ $t("Notify on Update") }}
                </label>
            </div>

            <div class="mb-4">
                <label class="form-check-label">
                    <input
                        v-model="config.notifyOnError"
                        class="form-check-input me-2"
                        type="checkbox"
                    />
                    {{ $t("Notify on Error") }}
                </label>
            </div>

            <div class="mb-4">
                <button
                    class="btn btn-primary me-2"
                    type="button"
                    :disabled="saving"
                    @click="saveConfig"
                >
                    <font-awesome-icon v-if="saving" icon="spinner" spin />
                    {{ $t("Save") }}
                </button>

                <button
                    class="btn btn-normal me-2"
                    type="button"
                    :disabled="running"
                    @click="runNow"
                >
                    <font-awesome-icon v-if="running" icon="spinner" spin />
                    {{ $t("Run Auto Update Now") }}
                </button>
            </div>
        </div>

        <div class="my-4">
            <h5 class="mb-3">
                <font-awesome-icon icon="cubes" />
                {{ $t("Auto Update Stacks") }}
            </h5>

            <div v-if="autoUpdateStacks.length === 0" class="text-muted mb-3">
                {{ $t("No stacks configured for auto-update") }}
            </div>

            <div v-for="stackName in autoUpdateStacks" :key="stackName" class="d-flex align-items-center mb-2">
                <span class="me-2">{{ stackName }}</span>
                <span class="badge bg-success me-2">{{ $t("Active") }}</span>
                <button
                    class="btn btn-outline-normal btn-sm"
                    @click="disableStackAutoUpdate(stackName)"
                >
                    {{ $t("Disable") }}
                </button>
            </div>

            <div v-if="availableStacks.length > 0" class="mt-3">
                <h6>{{ $t("Enable Auto Update for Stack") }}</h6>
                <div class="input-group" style="max-width: 400px;">
                    <select v-model="selectedStack" class="form-select">
                        <option value="" disabled>{{ $t("Select a stack") }}</option>
                        <option
                            v-for="stackName in availableStacks"
                            :key="stackName"
                            :value="stackName"
                        >
                            {{ stackName }}
                        </option>
                    </select>
                    <button
                        class="btn btn-primary"
                        type="button"
                        :disabled="!selectedStack"
                        @click="enableStackAutoUpdate"
                    >
                        {{ $t("Enable") }}
                    </button>
                </div>
            </div>
        </div>

        <div class="my-4">
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h5 class="mb-0">
                    <font-awesome-icon icon="history" />
                    {{ $t("Update Log") }}
                </h5>
                <button
                    class="btn btn-outline-normal btn-sm"
                    @click="clearLog"
                >
                    {{ $t("Clear Log") }}
                </button>
            </div>

            <div v-if="updateLog.length === 0" class="text-muted">
                {{ $t("No update logs") }}
            </div>

            <div v-for="entry in updateLog" :key="entry.id" class="log-entry mb-2 p-2">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <span class="fw-bold">{{ entry.stackName }}</span>
                        <span
                            class="badge ms-2"
                            :class="statusBadgeClass(entry.status)"
                        >
                            {{ entry.status }}
                        </span>
                    </div>
                    <small class="text-muted">{{ formatDate(entry.createdAt) }}</small>
                </div>
                <div v-if="entry.errorMessage" class="text-danger mt-1 small">
                    {{ entry.errorMessage }}
                </div>
                <div v-if="entry.status === 'success'" class="mt-1">
                    <button
                        class="btn btn-outline-normal btn-sm"
                        @click="rollback(entry.stackName)"
                    >
                        <font-awesome-icon icon="undo" />
                        {{ $t("Rollback") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            config: {
                enabled: false,
                schedule: "0 4 * * *",
                pruneImages: false,
                notifyOnUpdate: true,
                notifyOnError: true,
            },
            saving: false,
            running: false,
            autoUpdateStacks: [],
            allStackNames: [],
            selectedStack: "",
            updateLog: [],
        };
    },

    computed: {
        availableStacks() {
            return this.allStackNames.filter(
                (name) => !this.autoUpdateStacks.includes(name)
            );
        },
    },

    mounted() {
        this.loadConfig();
        this.loadAutoUpdateStacks();
        this.loadUpdateLog();
        this.loadAllStacks();
    },

    methods: {
        loadConfig() {
            this.$root.getSocket().emit("getAutoUpdateConfig", (res) => {
                if (res.ok) {
                    this.config = res.config;
                }
            });
        },

        saveConfig() {
            this.saving = true;
            this.$root.getSocket().emit("setAutoUpdateConfig", this.config, (res) => {
                this.saving = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.config = res.config;
                }
            });
        },

        loadAutoUpdateStacks() {
            this.$root.getSocket().emit("getAutoUpdateStacks", (res) => {
                if (res.ok) {
                    this.autoUpdateStacks = res.stacks;
                }
            });
        },

        loadAllStacks() {
            this.$root.getSocket().emit("requestStackList", (res) => {
                if (res.ok) {
                    this.allStackNames = Object.keys(res.stackList);
                }
            });
        },

        loadUpdateLog() {
            this.$root.getSocket().emit("getAutoUpdateLog", null, (res) => {
                if (res.ok) {
                    this.updateLog = res.log;
                }
            });
        },

        enableStackAutoUpdate() {
            if (!this.selectedStack) {
                return;
            }
            this.$root.getSocket().emit("setStackAutoUpdate", this.selectedStack, true, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.selectedStack = "";
                    this.loadAutoUpdateStacks();
                }
            });
        },

        disableStackAutoUpdate(stackName) {
            this.$root.getSocket().emit("setStackAutoUpdate", stackName, false, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.loadAutoUpdateStacks();
                }
            });
        },

        runNow() {
            this.running = true;
            this.$root.getSocket().emit("runAutoUpdateNow", (res) => {
                this.running = false;
                this.$root.toastRes(res);
                setTimeout(() => {
                    this.loadUpdateLog();
                }, 5000);
            });
        },

        rollback(stackName) {
            this.$root.getSocket().emit("rollbackStack", stackName, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.loadUpdateLog();
                }
            });
        },

        clearLog() {
            this.$root.getSocket().emit("clearAutoUpdateLog", null, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.updateLog = [];
                }
            });
        },

        statusBadgeClass(status) {
            switch (status) {
                case "success":
                    return "bg-success";
                case "error":
                    return "bg-danger";
                case "rollback":
                    return "bg-warning";
                case "no_update":
                    return "bg-secondary";
                default:
                    return "bg-secondary";
            }
        },

        formatDate(dateStr) {
            if (!dateStr) {
                return "";
            }
            try {
                return new Date(dateStr).toLocaleString();
            } catch (e) {
                return dateStr;
            }
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../styles/vars.scss";

.log-entry {
    border-radius: 8px;
    background-color: $highlight-white;

    .dark & {
        background-color: $dark-header-bg;
    }
}
</style>
