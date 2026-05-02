<template>
    <form @submit.prevent="submit">
        <div ref="modal" class="modal fade" tabindex="-1" data-bs-backdrop="static">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            {{ $t("2FA Settings") }}
                            <span v-if="twoFAStatus == true" class="badge bg-success">{{ $t("Active") }}</span>
                            <span v-if="twoFAStatus == false" class="badge bg-secondary">{{ $t("Inactive") }}</span>
                        </h5>
                        <button :disabled="processing" type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close" />
                    </div>
                    <div class="modal-body">

                        <!-- Step 1: Enable TOTP (when 2FA is not active) -->
                        <div v-if="twoFAStatus == false && !uri" class="mb-3">
                            <h6 class="mb-3">{{ $t("Enable TOTP 2FA") }}</h6>
                            <div class="alert alert-info">
                                <strong>{{ $t("How TOTP works") }}</strong>
                                <p class="mb-0">{{ $t("TOTP uses an authenticator app (like Google Authenticator, Authy, or Microsoft Authenticator) to generate time-based verification codes.") }}</p>
                            </div>
                            <div class="mb-3">
                                <label for="current-password-totp" class="form-label">
                                    {{ $t("Current Password") }}
                                </label>
                                <input
                                    id="current-password-totp"
                                    v-model="currentPassword"
                                    type="password"
                                    class="form-control"
                                    autocomplete="current-password"
                                    required
                                />
                            </div>
                            <button class="btn btn-primary" type="button" :disabled="processing || !currentPassword" @click="prepare2FA()">
                                <div v-if="processing" class="spinner-border spinner-border-sm me-1"></div>
                                {{ $t("Enable 2FA") }}
                            </button>
                        </div>

                        <!-- Step 2: QR Code Display (after prepare2FA) -->
                        <div v-if="uri && twoFAStatus == false" class="mb-3">
                            <h6 class="mb-3">{{ $t("Scan QR Code") }}</h6>
                            <div class="row">
                                <div class="col-md-6 text-center">
                                    <div class="mx-auto" style="width: 210px;">
                                        <vue-qrcode :key="uri" :value="uri" type="image/png" :quality="1" :color="{ light: '#ffffffff' }" />
                                    </div>
                                    <button v-show="!showURI" type="button" class="btn btn-outline-primary btn-sm mt-2" @click="showURI = true">{{ $t("Show URI") }}</button>
                                </div>
                                <div class="col-md-6">
                                    <div class="alert alert-warning">
                                        <strong>{{ $t("Important!") }}</strong>
                                        <ol class="mb-0 mt-1">
                                            <li>{{ $t("Open your authenticator app") }}</li>
                                            <li>{{ $t("Add a new account by scanning this QR code") }}</li>
                                            <li>{{ $t("Enter the 6-digit code below to verify") }}</li>
                                        </ol>
                                    </div>
                                    <p v-if="showURI" class="text-break mt-2 alert alert-secondary"><small>{{ uri }}</small></p>
                                </div>
                            </div>

                            <div class="mt-3">
                                <label for="verify-token" class="form-label">{{ $t("twoFAVerifyLabel") }}</label>
                                <div class="input-group">
                                    <input id="verify-token" v-model="token" type="text" maxlength="6" class="form-control" autocomplete="one-time-code" required placeholder="000000">
                                    <button class="btn btn-outline-primary" type="button" @click="verifyToken()">{{ $t("Verify Token") }}</button>
                                </div>
                                <p v-show="tokenValid" class="mt-2" style="color: green;">
                                    <i class="fas fa-check-circle"></i> {{ $t("tokenValidSettingsMsg") }}
                                </p>
                                <p v-show="tokenValid === false && tokenVerified" class="mt-2 text-danger">
                                    <i class="fas fa-times-circle"></i> {{ $t("Invalid token, please try again") }}
                                </p>
                            </div>
                        </div>

                        <!-- 2FA is Active - Settings Panel -->
                        <div v-if="twoFAStatus == true">
                            <!-- Current Method Display -->
                            <div class="mb-4">
                                <h6 class="mb-3">{{ $t("Current 2FA Method") }}</h6>
                                <div class="d-flex align-items-center">
                                    <div class="form-check me-3">
                                        <input id="method-totp" v-model="currentMethod" class="form-check-input" type="radio" value="totp" :disabled="switchingMethod">
                                        <label class="form-check-label" for="method-totp">
                                            <i class="fas fa-mobile-alt me-1"></i> {{ $t("Authenticator App (TOTP)") }}
                                        </label>
                                    </div>
                                    <div class="form-check">
                                        <input id="method-sms" v-model="currentMethod" class="form-check-input" type="radio" value="sms" :disabled="switchingMethod || !smsPhone">
                                        <label class="form-check-label" for="method-sms">
                                            <i class="fas fa-sms me-1"></i> {{ $t("SMS Verification") }}
                                            <span v-if="!smsPhone" class="text-muted">({{ $t("Setup required") }})</span>
                                        </label>
                                    </div>
                                </div>
                                <button v-if="currentMethod !== originalMethod" class="btn btn-primary btn-sm mt-2" :disabled="switchingMethod" @click="switchMethod()">
                                    <div v-if="switchingMethod" class="spinner-border spinner-border-sm me-1"></div>
                                    {{ $t("Switch Method") }}
                                </button>
                            </div>

                            <!-- SMS Setup Section -->
                            <div class="mb-4">
                                <h6 class="mb-3">{{ $t("SMS Verification Setup") }}</h6>
                                <div class="alert alert-secondary">
                                    <small>{{ $t("SMS verification sends a code to your phone as a backup 2FA method. You must enable TOTP first before adding SMS.") }}</small>
                                </div>
                                <div class="row">
                                    <div class="col-md-8">
                                        <div class="mb-3">
                                            <label for="sms-phone" class="form-label">{{ $t("Phone Number") }}</label>
                                            <input id="sms-phone" v-model="smsPhoneInput" type="tel" class="form-control" placeholder="+1234567890">
                                        </div>
                                    </div>
                                    <div class="col-md-4 d-flex align-items-end">
                                        <button class="btn btn-outline-primary btn-sm" :disabled="!smsPhoneInput" @click="setupSMS()">
                                            {{ smsPhone ? $t("Update Phone") : $t("Save Phone") }}
                                        </button>
                                    </div>
                                </div>
                                <div v-if="smsPhone" class="mt-2">
                                    <button class="btn btn-outline-secondary btn-sm" @click="sendTestSMS()">
                                        <i class="fas fa-paper-plane me-1"></i> {{ $t("Send Test Code") }}
                                    </button>
                                    <span v-if="testSMSSent" class="text-success ms-2"><i class="fas fa-check"></i> {{ $t("Code sent! Check server logs.") }}</span>
                                </div>
                            </div>

                            <!-- Recovery Codes Section -->
                            <div class="mb-4">
                                <h6 class="mb-3">{{ $t("Recovery Codes") }}</h6>
                                <div class="alert alert-warning">
                                    <small>{{ $t("Recovery codes can be used to access your account if you lose your authenticator device. Each code can only be used once. Store them in a safe place!") }}</small>
                                </div>

                                <div v-if="showRecoveryCodes && displayedRecoveryCodes.length > 0" class="mb-3">
                                    <div class="card">
                                        <div class="card-body">
                                            <div class="row">
                                                <div v-for="(code, index) in displayedRecoveryCodes" :key="index" class="col-md-6">
                                                    <code class="fs-6">{{ code }}</code>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="mt-2">
                                        <button class="btn btn-outline-secondary btn-sm" @click="copyRecoveryCodes">
                                            <i class="fas fa-copy me-1"></i> {{ $t("Copy Codes") }}
                                        </button>
                                        <button class="btn btn-outline-secondary btn-sm ms-2" @click="showRecoveryCodes = false">
                                            {{ $t("Hide Codes") }}
                                        </button>
                                    </div>
                                </div>

                                <div v-if="!showRecoveryCodes">
                                    <button class="btn btn-outline-primary btn-sm me-2" @click="showExistingRecoveryCodes">
                                        <i class="fas fa-eye me-1"></i> {{ $t("Show Recovery Codes") }}
                                    </button>
                                    <button class="btn btn-outline-warning btn-sm" @click="confirmRegenerateCodes">
                                        <i class="fas fa-sync me-1"></i> {{ $t("Regenerate Codes") }}
                                    </button>
                                </div>

                                <div class="mt-2">
                                    <span class="text-muted">{{ $t("Recovery Codes") }}: {{ recoveryCodesCount }} {{ $t("remaining") }}</span>
                                </div>
                            </div>

                            <!-- Disable 2FA Section -->
                            <div class="mb-3">
                                <h6 class="mb-3 text-danger">{{ $t("Disable 2FA") }}</h6>
                                <p class="text-muted">{{ $t("Disabling 2FA will remove the extra layer of security from your account.") }}</p>
                                <button class="btn btn-outline-danger btn-sm" @click="confirmDisableTwoFA()">
                                    {{ $t("Disable 2FA") }}
                                </button>
                            </div>
                        </div>
                    </div>

                    <div v-if="uri && twoFAStatus == false" class="modal-footer">
                        <button type="submit" class="btn btn-primary" :disabled="processing || tokenValid == false" @click="confirmEnableTwoFA()">
                            <div v-if="processing" class="spinner-border spinner-border-sm me-1"></div>
                            {{ $t("Save") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </form>

    <Confirm ref="confirmEnableTwoFA" btn-style="btn-primary" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="save2FA">
        {{ $t("confirmEnableTwoFAMsg") }}
    </Confirm>

    <Confirm ref="confirmDisableTwoFA" btn-style="btn-danger" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="disable2FA">
        {{ $t("confirmDisableTwoFAMsg") }}
    </Confirm>

    <Confirm ref="confirmRegenerateCodes" btn-style="btn-warning" :yes-text="$t('Regenerate')" :no-text="$t('Cancel')" @yes="regenerateRecoveryCodes">
        {{ $t("Regenerating recovery codes will invalidate all existing codes. Are you sure?") }}
    </Confirm>
</template>

<script lang="ts">
import { Modal } from "bootstrap";
import Confirm from "./Confirm.vue";
import VueQrcode from "vue-qrcode";
import { useToast } from "vue-toastification";
const toast = useToast();

export default {
    components: {
        Confirm,
        VueQrcode,
    },
    emits: ["status-changed"],
    props: {},
    data() {
        return {
            currentPassword: "",
            processing: false,
            uri: null,
            tokenValid: false,
            tokenVerified: false,
            twoFAStatus: null,
            token: null,
            showURI: false,
            currentMethod: "totp",
            originalMethod: "totp",
            smsPhone: "",
            smsPhoneInput: "",
            switchingMethod: false,
            showRecoveryCodes: false,
            displayedRecoveryCodes: [],
            recoveryCodesCount: 0,
            testSMSSent: false,
        };
    },
    mounted() {
        this.modal = new Modal(this.$refs.modal);
        this.getStatus();
    },
    methods: {
        show() {
            this.resetState();
            this.getStatus();
            this.modal.show();
        },

        resetState() {
            this.uri = null;
            this.token = null;
            this.tokenValid = false;
            this.tokenVerified = false;
            this.currentPassword = "";
            this.showURI = false;
            this.showRecoveryCodes = false;
            this.displayedRecoveryCodes = [];
            this.testSMSSent = false;
        },

        getStatus() {
            this.$root.getSocket().emit("twoFAStatus", (res) => {
                if (res.ok) {
                    this.twoFAStatus = res.status;
                    this.currentMethod = res.method || "totp";
                    this.originalMethod = res.method || "totp";
                    this.smsPhone = res.phone || "";
                    this.smsPhoneInput = res.phone || "";
                    this.recoveryCodesCount = res.recoveryCodesCount || 0;
                } else {
                    toast.error(res.msg);
                }
            });
        },

        prepare2FA() {
            this.processing = true;

            this.$root.getSocket().emit("prepare2FA", this.currentPassword, (res) => {
                this.processing = false;

                if (res.ok) {
                    this.uri = res.uri;
                } else {
                    toast.error(res.msg);
                }
            });
        },

        verifyToken() {
            this.tokenVerified = false;
            this.$root.getSocket().emit("verifyToken", this.token, this.currentPassword, (res) => {
                if (res.ok) {
                    this.tokenValid = res.valid;
                    this.tokenVerified = true;
                } else {
                    toast.error(res.msg);
                }
            });
        },

        confirmEnableTwoFA() {
            this.$refs.confirmEnableTwoFA.show();
        },

        save2FA() {
            this.processing = true;

            this.$root.getSocket().emit("save2FA", this.currentPassword, (res) => {
                this.processing = false;

                if (res.ok) {
                    this.$root.toastRes(res);
                    if (res.recoveryCodes && res.recoveryCodes.length > 0) {
                        this.displayedRecoveryCodes = res.recoveryCodes;
                        this.showRecoveryCodes = true;
                    }
                    this.getStatus();
                    this.currentPassword = "";
                    this.$emit("status-changed");
                } else {
                    toast.error(res.msg);
                }
            });
        },

        confirmDisableTwoFA() {
            this.$refs.confirmDisableTwoFA.show();
        },

        disable2FA() {
            this.processing = true;

            this.$root.getSocket().emit("disable2FA", this.currentPassword, (res) => {
                this.processing = false;

                if (res.ok) {
                    this.$root.toastRes(res);
                    this.getStatus();
                    this.currentPassword = "";
                    this.modal.hide();
                    this.$emit("status-changed");
                } else {
                    toast.error(res.msg);
                }
            });
        },

        setupSMS() {
            this.$root.getSocket().emit("setupSMS2FA", this.smsPhoneInput, this.currentPassword, (res) => {
                if (res.ok) {
                    this.$root.toastRes(res);
                    this.smsPhone = this.smsPhoneInput;
                } else {
                    toast.error(res.msg);
                }
            });
        },

        switchMethod() {
            this.switchingMethod = true;
            this.$root.getSocket().emit("switch2FAMethod", this.currentMethod, this.currentPassword, (res) => {
                this.switchingMethod = false;
                if (res.ok) {
                    this.$root.toastRes(res);
                    this.originalMethod = this.currentMethod;
                    this.getStatus();
                } else {
                    toast.error(res.msg);
                    this.currentMethod = this.originalMethod;
                }
            });
        },

        sendTestSMS() {
            this.testSMSSent = false;
            this.$root.getSocket().emit("requestSMSCode", this.currentPassword, (res) => {
                if (res.ok) {
                    this.testSMSSent = true;
                    setTimeout(() => { this.testSMSSent = false; }, 5000);
                } else {
                    toast.error(res.msg);
                }
            });
        },

        showExistingRecoveryCodes() {
            this.$root.getSocket().emit("generateRecoveryCodes", this.currentPassword, (res) => {
                if (res.ok) {
                    this.displayedRecoveryCodes = res.recoveryCodes;
                    this.showRecoveryCodes = true;
                    this.recoveryCodesCount = res.recoveryCodes.length;
                } else {
                    toast.error(res.msg);
                }
            });
        },

        confirmRegenerateCodes() {
            this.$refs.confirmRegenerateCodes.show();
        },

        regenerateRecoveryCodes() {
            this.$root.getSocket().emit("generateRecoveryCodes", this.currentPassword, (res) => {
                if (res.ok) {
                    this.displayedRecoveryCodes = res.recoveryCodes;
                    this.showRecoveryCodes = true;
                    this.recoveryCodesCount = res.recoveryCodes.length;
                    toast.success(this.$t("Recovery codes regenerated successfully"));
                } else {
                    toast.error(res.msg);
                }
            });
        },

        copyRecoveryCodes() {
            const text = this.displayedRecoveryCodes.join("\n");
            navigator.clipboard.writeText(text).then(() => {
                toast.success(this.$t("Recovery codes copied to clipboard"));
            }).catch(() => {
                toast.error(this.$t("Failed to copy recovery codes"));
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.dark {
    .modal-dialog .form-text, .modal-dialog p {
        color: $dark-font-color;
    }
}
</style>
