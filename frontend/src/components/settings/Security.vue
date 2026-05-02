<template>
    <div>
        <div v-if="settingsLoaded" class="my-4">
            <!-- Change Password -->
            <template v-if="!settings.disableAuth">
                <p>
                    {{ $t("Current User") }}: <strong>{{ $root.username }}</strong>
                    <button v-if="! settings.disableAuth" id="logout-btn" class="btn btn-danger ms-4 me-2 mb-2" @click="$root.logout">{{ $t("Logout") }}</button>
                </p>

                <h5 class="my-4 settings-subheading">{{ $t("Change Password") }}</h5>
                <form class="mb-3" @submit.prevent="savePassword">
                    <div class="mb-3">
                        <label for="current-password" class="form-label">
                            {{ $t("Current Password") }}
                        </label>
                        <input
                            id="current-password"
                            v-model="password.currentPassword"
                            type="password"
                            class="form-control"
                            autocomplete="current-password"
                            required
                        />
                    </div>

                    <div class="mb-3">
                        <label for="new-password" class="form-label">
                            {{ $t("New Password") }}
                        </label>
                        <input
                            id="new-password"
                            v-model="password.newPassword"
                            type="password"
                            class="form-control"
                            autocomplete="new-password"
                            required
                        />
                    </div>

                    <div class="mb-3">
                        <label for="repeat-new-password" class="form-label">
                            {{ $t("Repeat New Password") }}
                        </label>
                        <input
                            id="repeat-new-password"
                            v-model="password.repeatNewPassword"
                            type="password"
                            class="form-control"
                            :class="{ 'is-invalid': invalidPassword }"
                            autocomplete="new-password"
                            required
                        />
                        <div class="invalid-feedback">
                            {{ $t("passwordNotMatchMsg") }}
                        </div>
                    </div>

                    <div>
                        <button class="btn btn-primary" type="submit">
                            {{ $t("Update Password") }}
                        </button>
                    </div>
                </form>
            </template>

            <!-- Two Factor Authentication -->
            <div v-if="! settings.disableAuth" class="mt-5 mb-3">
                <h5 class="my-4 settings-subheading">
                    {{ $t("Two Factor Authentication") }}
                </h5>

                <div v-if="twoFAStatus === null" class="mb-3">
                    <div class="spinner-border spinner-border-sm me-1"></div>
                    {{ $t("Loading...") }}
                </div>

                <div v-else class="mb-4">
                    <div class="d-flex align-items-center mb-3">
                        <span v-if="twoFAStatus" class="badge bg-success me-2">{{ $t("Active") }}</span>
                        <span v-else class="badge bg-secondary me-2">{{ $t("Inactive") }}</span>
                    </div>

                    <div v-if="twoFAStatus" class="mb-3">
                        <button class="btn btn-primary me-2 mb-2" type="button" @click="$refs.TwoFADialog.show()">
                            {{ $t("2FA Settings") }}
                        </button>
                        <button class="btn btn-outline-danger me-2 mb-2" type="button" @click="confirmDisable2FA">
                            {{ $t("Disable 2FA") }}
                        </button>
                    </div>

                    <div v-if="!twoFAStatus">
                        <div class="alert alert-info mb-3">
                            <strong>{{ $t("2FA Setup Guide") }}</strong>
                            <ol class="mb-0 mt-2">
                                <li>{{ $t("2FA Step 1 - Click enable button below") }}</li>
                                <li>{{ $t("2FA Step 2 - Scan QR code with authenticator app") }}</li>
                                <li>{{ $t("2FA Step 3 - Enter the verification code to confirm") }}</li>
                                <li>{{ $t("2FA Step 4 - Save your recovery codes in a safe place") }}</li>
                            </ol>
                        </div>
                        <button class="btn btn-primary me-2 mb-2" type="button" @click="$refs.TwoFADialog.show()">
                            {{ $t("Enable 2FA") }}
                        </button>
                    </div>

                    <div v-if="twoFAStatus && recoveryCodesCount !== null" class="mt-3">
                        <p class="form-text">
                            {{ $t("Recovery Codes") }}: {{ recoveryCodesCount }} {{ $t("remaining") }}
                            <span v-if="recoveryCodesCount <= 2" class="text-warning ms-1">
                                ({{ $t("Low recovery codes, please regenerate") }})
                            </span>
                        </p>
                    </div>
                </div>
            </div>

            <div class="my-4">
                <!-- Advanced -->
                <h5 class="my-4 settings-subheading">{{ $t("Advanced") }}</h5>

                <div class="mb-4">
                    <button v-if="settings.disableAuth" id="enableAuth-btn" class="btn btn-outline-primary me-2 mb-2" @click="enableAuth">{{ $t("Enable Auth") }}</button>
                    <button v-if="! settings.disableAuth" id="disableAuth-btn" class="btn btn-primary me-2 mb-2" @click="confirmDisableAuth">{{ $t("Disable Auth") }}</button>
                </div>
            </div>
        </div>

        <TwoFADialog ref="TwoFADialog" @status-changed="fetch2FAStatus" />

        <Confirm ref="confirmDisableAuth" btn-style="btn-danger" :yes-text="$t('I understand, please disable')" :no-text="$t('Leave')" @yes="disableAuth">
            <i18n-t keypath="disableauth.message1" tag="p">
                <template #disableAuth>
                    <strong>{{ $t('disableAuth') }}</strong>
                </template>
            </i18n-t>

            <i18n-t keypath="disableauth.message2" tag="p">
                <template #scenarios>
                    <strong>{{ $t('scenarios') }}</strong>
                </template>
            </i18n-t>

            <p>{{ $t("Please use this option carefully!") }}</p>

            <div class="mb-3">
                <label for="current-password2" class="form-label">
                    {{ $t("Current Password") }}
                </label>
                <input
                    id="current-password2"
                    v-model="password.currentPassword"
                    type="password"
                    class="form-control"
                    required
                />
            </div>
        </Confirm>

        <Confirm ref="confirmDisable2FA" btn-style="btn-danger" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="disable2FA">
            <p>{{ $t("confirmDisableTwoFAMsg") }}</p>
            <div class="mb-3">
                <label for="disable-2fa-password" class="form-label">
                    {{ $t("Current Password") }}
                </label>
                <input
                    id="disable-2fa-password"
                    v-model="disable2FAPassword"
                    type="password"
                    class="form-control"
                    required
                />
            </div>
        </Confirm>
    </div>
</template>

<script>
import Confirm from "../../components/Confirm.vue";
import TwoFADialog from "../../components/TwoFADialog.vue";
import { useToast } from "vue-toastification";
const toast = useToast();

export default {
    components: {
        Confirm,
        TwoFADialog
    },

    data() {
        return {
            invalidPassword: false,
            password: {
                currentPassword: "",
                newPassword: "",
                repeatNewPassword: "",
            },
            twoFAStatus: null,
            recoveryCodesCount: null,
            disable2FAPassword: "",
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
        }
    },

    watch: {
        "password.repeatNewPassword"() {
            this.invalidPassword = false;
        },
    },

    mounted() {
        this.fetch2FAStatus();
    },

    methods: {
        fetch2FAStatus() {
            this.$root.getSocket().emit("twoFAStatus", (res) => {
                if (res.ok) {
                    this.twoFAStatus = res.status;
                    this.recoveryCodesCount = res.recoveryCodesCount;
                } else {
                    toast.error(res.msg);
                }
            });
        },

        savePassword() {
            if (this.password.newPassword !== this.password.repeatNewPassword) {
                this.invalidPassword = true;
            } else {
                this.$root
                    .getSocket()
                    .emit("changePassword", this.password, (res) => {
                        this.$root.toastRes(res);
                        if (res.ok) {
                            this.password.currentPassword = "";
                            this.password.newPassword = "";
                            this.password.repeatNewPassword = "";
                        }
                    });
            }
        },

        confirmDisable2FA() {
            this.disable2FAPassword = "";
            this.$refs.confirmDisable2FA.show();
        },

        disable2FA() {
            this.$root.getSocket().emit("disable2FA", this.disable2FAPassword, (res) => {
                if (res.ok) {
                    this.$root.toastRes(res);
                    this.fetch2FAStatus();
                    this.disable2FAPassword = "";
                } else {
                    toast.error(res.msg);
                }
            });
        },

        disableAuth() {
            this.settings.disableAuth = true;

            this.saveSettings(() => {
                this.password.currentPassword = "";
                this.$root.username = null;
                this.$root.socketIO.token = "autoLogin";
            }, this.password.currentPassword);
        },

        enableAuth() {
            this.settings.disableAuth = false;
            this.saveSettings();
            this.$root.storage().removeItem("token");
            location.reload();
        },

        confirmDisableAuth() {
            this.$refs.confirmDisableAuth.show();
        },

    },
};
</script>
