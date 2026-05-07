<template>
    <div class="d-flex justify-content-center align-items-center">
        <div class="logo d-flex flex-column justify-content-center align-items-center">
            <object class="my-4" width="200" height="200" data="/icon.svg" />
            <div class="fs-4 fw-bold">Dockge</div>
            <div>{{ $t("Version") }}: {{ $root.info.version }}</div>
            <div class="frontend-version">{{ $t("Frontend Version") }}: {{ $root.frontendVersion }}</div>

            <div v-if="!$root.isFrontendBackendVersionMatched" class="alert alert-warning mt-4" role="alert">
                ⚠️ {{ $t("Frontend Version do not match backend version!") }}
            </div>

            <div v-if="autoUpdateStatus.updateAvailable" class="alert alert-success mt-3" role="alert">
                🎉 {{ $t("New version available") }}: {{ autoUpdateStatus.latestVersion }}
            </div>

            <div class="my-3 update-link"><a href="https://github.com/louislam/dockge/releases" target="_blank" rel="noopener">{{ $t("Check Update On GitHub") }}</a></div>

            <div class="mt-1">
                <div class="form-check">
                    <label><input v-model="settings.checkUpdate" type="checkbox" @change="saveSettings()" /> {{ $t("Show update if available") }}</label>
                </div>

                <div class="form-check">
                    <label><input v-model="settings.checkBeta" type="checkbox" :disabled="!settings.checkUpdate" @change="saveSettings()" /> {{ $t("Also check beta release") }}</label>
                </div>
            </div>

            <hr class="my-4 w-100">

            <div class="w-100">
                <h5 class="mb-3">{{ $t("Auto Update") }}</h5>

                <div class="form-check">
                    <label>
                        <input v-model="autoUpdateEnabled" type="checkbox" @change="setAutoUpdate" />
                        {{ $t("Enable Auto Update") }}
                    </label>
                </div>
                <p class="form-text">{{ $t("Automatically download and install updates when available") }}</p>

                <div v-if="autoUpdateEnabled" class="mt-3">
                    <label class="form-label">{{ $t("Update Window") }}</label>
                    <select v-model="autoUpdateWindow" class="form-select" @change="setAutoUpdateWindow">
                        <option value="any">{{ $t("Any time") }}</option>
                        <option value="0-6">{{ $t("Midnight to 6 AM") }}</option>
                        <option value="2-4">{{ $t("2 AM to 4 AM") }}</option>
                        <option value="3-5">{{ $t("3 AM to 5 AM") }}</option>
                        <option value="4-6">{{ $t("4 AM to 6 AM") }}</option>
                    </select>
                    <p class="form-text">{{ $t("Updates will only be applied during the selected time window") }}</p>
                </div>

                <div v-if="autoUpdateStatus.lastCheck" class="mt-3">
                    <p class="form-text">
                        {{ $t("Last checked") }}: {{ formatTime(autoUpdateStatus.lastCheck) }}
                    </p>
                </div>

                <div v-if="autoUpdateStatus.lastError" class="mt-2">
                    <p class="text-danger">
                        {{ $t("Last error") }}: {{ autoUpdateStatus.lastError }}
                    </p>
                </div>

                <div class="mt-3 d-flex gap-2">
                    <button class="btn btn-outline-primary" type="button" :disabled="checking" @click="checkForUpdate">
                        <div v-if="checking" class="spinner-border spinner-border-sm me-1"></div>
                        {{ $t("Check Now") }}
                    </button>

                    <button
                        v-if="autoUpdateStatus.updateAvailable"
                        class="btn btn-primary"
                        type="button"
                        :disabled="updating"
                        @click="performUpdate"
                    >
                        <div v-if="updating" class="spinner-border spinner-border-sm me-1"></div>
                        {{ $t("Update Now") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { useToast } from "vue-toastification";
const toast = useToast();

export default {
    data() {
        return {
            autoUpdateStatus: {
                enabled: false,
                updateWindow: "any",
                lastCheck: null,
                lastAttempt: null,
                lastError: null,
                latestVersion: null,
                currentVersion: "",
                updateAvailable: false,
            },
            autoUpdateEnabled: false,
            autoUpdateWindow: "any",
            checking: false,
            updating: false,
        };
    },

    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
    },

    mounted() {
        this.fetchAutoUpdateStatus();
    },

    methods: {
        fetchAutoUpdateStatus() {
            this.$root.getSocket().emit("autoUpdateStatus", (res) => {
                if (res.ok) {
                    this.autoUpdateStatus = res.status;
                    this.autoUpdateEnabled = res.status.enabled;
                    this.autoUpdateWindow = res.status.updateWindow || "any";
                }
            });
        },

        setAutoUpdate() {
            this.$root.getSocket().emit("setAutoUpdate", this.autoUpdateEnabled, (res) => {
                if (res.ok) {
                    toast.success(this.$t(res.msg));
                } else {
                    toast.error(res.msg);
                    this.autoUpdateEnabled = !this.autoUpdateEnabled;
                }
            });
        },

        setAutoUpdateWindow() {
            this.$root.getSocket().emit("setAutoUpdateWindow", this.autoUpdateWindow, (res) => {
                if (res.ok) {
                    toast.success(this.$t(res.msg));
                } else {
                    toast.error(res.msg);
                }
            });
        },

        checkForUpdate() {
            this.checking = true;
            this.$root.getSocket().emit("checkForUpdate", (res) => {
                this.checking = false;
                if (res.ok) {
                    this.autoUpdateStatus.latestVersion = res.latestVersion;
                    this.autoUpdateStatus.currentVersion = res.currentVersion;
                    this.autoUpdateStatus.updateAvailable = res.updateAvailable;
                    this.autoUpdateStatus.lastCheck = Date.now();

                    if (res.updateAvailable) {
                        toast.success(this.$t("New version available") + ": " + res.latestVersion);
                    } else {
                        toast.success(this.$t("You are on the latest version"));
                    }
                } else {
                    toast.error(res.msg);
                }
            });
        },

        performUpdate() {
            this.updating = true;
            this.$root.getSocket().emit("performUpdate", (res) => {
                if (res.ok) {
                    toast.success(this.$t(res.msg));
                } else {
                    this.updating = false;
                    toast.error(res.msg);
                }
            });
        },

        formatTime(timestamp) {
            if (!timestamp) return "";
            const date = new Date(timestamp);
            return date.toLocaleString();
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../styles/vars.scss";

.logo {
    margin: 4em 1em;
    max-width: 500px;
}

.update-link {
    font-size: 0.8em;
}

.frontend-version {
    font-size: 0.9em;
    color: $text-muted;

    .dark & {
        color: $dark-font-color;
    }
}

hr {
    border-color: $border-light;

    .dark & {
        border-color: $dark-border-color;
    }
}

.gap-2 {
    gap: 0.5rem;
}
</style>
