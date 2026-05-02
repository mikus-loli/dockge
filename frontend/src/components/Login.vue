<template>
    <div class="form-container">
        <div class="form">
            <form @submit.prevent="submit">
                <h1 class="h3 mb-3 fw-normal" />

                <!-- Step 1: Username & Password -->
                <template v-if="!tokenRequired">
                    <div class="form-floating">
                        <input id="floatingInput" v-model="username" type="text" class="form-control" placeholder="Username" autocomplete="username" required>
                        <label for="floatingInput">{{ $t("Username") }}</label>
                    </div>

                    <div class="form-floating mt-3">
                        <input id="floatingPassword" v-model="password" type="password" class="form-control" placeholder="Password" autocomplete="current-password" required>
                        <label for="floatingPassword">{{ $t("Password") }}</label>
                    </div>
                </template>

                <!-- Step 2: 2FA Verification -->
                <div v-if="tokenRequired">
                    <div class="text-center mb-3">
                        <i class="fas fa-shield-alt fa-2x text-primary"></i>
                        <h5 class="mt-2">{{ $t("Two Factor Authentication") }}</h5>
                        <p class="text-muted small">
                            <template v-if="twoFAMethod === 'totp'">
                                {{ $t("Enter the verification code from your authenticator app.") }}
                            </template>
                            <template v-else-if="twoFAMethod === 'sms'">
                                {{ $t("Enter the verification code sent to your phone.") }}
                            </template>
                        </p>
                    </div>

                    <!-- Tab selection for token vs recovery code -->
                    <ul class="nav nav-tabs mb-3">
                        <li class="nav-item">
                            <button class="nav-link" :class="{ active: !useRecoveryCode }" @click="useRecoveryCode = false">
                                <i class="fas fa-key me-1"></i> {{ twoFAMethod === 'sms' ? $t('SMS Code') : $t('Authenticator Code') }}
                            </button>
                        </li>
                        <li class="nav-item">
                            <button class="nav-link" :class="{ active: useRecoveryCode }" @click="useRecoveryCode = true">
                                <i class="fas fa-unlock-alt me-1"></i> {{ $t("Recovery Code") }}
                            </button>
                        </li>
                    </ul>

                    <!-- Token input -->
                    <div v-if="!useRecoveryCode">
                        <div class="form-floating mt-3">
                            <input id="otp" v-model="token" type="text" maxlength="6" class="form-control" placeholder="123456" autocomplete="one-time-code" required>
                            <label for="otp">{{ twoFAMethod === 'sms' ? $t('SMS Code') : $t('Token') }}</label>
                        </div>
                        <div v-if="twoFAMethod === 'sms'" class="mt-2 text-center">
                            <button type="button" class="btn btn-outline-secondary btn-sm" :disabled="smsCooldown > 0" @click="requestSMSCode">
                                <i class="fas fa-paper-plane me-1"></i>
                                <template v-if="smsCooldown > 0">
                                    {{ $t("Resend in") }} {{ smsCooldown }}s
                                </template>
                                <template v-else>
                                    {{ $t("Send Code") }}
                                </template>
                            </button>
                        </div>
                    </div>

                    <!-- Recovery code input -->
                    <div v-if="useRecoveryCode">
                        <div class="form-floating mt-3">
                            <input id="recovery-code" v-model="recoveryCode" type="text" class="form-control" :placeholder="$t('XXXX-XXXX')" autocomplete="off" required>
                            <label for="recovery-code">{{ $t("Recovery Code") }}</label>
                        </div>
                        <div class="alert alert-warning mt-2 small">
                            {{ $t("Each recovery code can only be used once. After login, please generate new recovery codes.") }}
                        </div>
                    </div>

                    <div class="mt-2">
                        <button type="button" class="btn btn-outline-secondary btn-sm" @click="goBack">
                            <i class="fas fa-arrow-left me-1"></i> {{ $t("Back") }}
                        </button>
                    </div>
                </div>

                <div class="form-check mb-3 mt-3 d-flex justify-content-center pe-4">
                    <div class="form-check">
                        <input id="remember" v-model="$root.remember" type="checkbox" value="remember-me" class="form-check-input">

                        <label class="form-check-label" for="remember">
                            {{ $t("Remember me") }}
                        </label>
                    </div>
                </div>
                <button class="w-100 btn btn-primary" type="submit" :disabled="processing">
                    <div v-if="processing" class="spinner-border spinner-border-sm me-1"></div>
                    {{ $t("Login") }}
                </button>

                <div v-if="res && !res.ok" class="alert alert-danger mt-3" role="alert">
                    {{ $t(res.msg) }}
                    <div v-if="res.attemptsRemaining !== undefined && res.attemptsRemaining > 0" class="small mt-1">
                        {{ $t("Attempts remaining") }}: {{ res.attemptsRemaining }}
                    </div>
                    <div v-if="res.lockoutMinutes" class="small mt-1">
                        {{ $t("Account locked for") }} {{ res.lockoutMinutes }} {{ $t("minutes") }}
                    </div>
                </div>

                <div v-if="res && res.recoveryCodeUsed" class="alert alert-warning mt-3" role="alert">
                    {{ $t("You logged in with a recovery code. Please generate new recovery codes from Settings > Security.") }}
                </div>
            </form>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            processing: false,
            username: "",
            password: "",
            token: "",
            recoveryCode: "",
            res: null,
            tokenRequired: false,
            twoFAMethod: "totp",
            useRecoveryCode: false,
            smsCooldown: 0,
            smsCooldownTimer: null,
        };
    },

    mounted() {
        document.title += " - Login";
    },

    unmounted() {
        document.title = document.title.replace(" - Login", "");
        if (this.smsCooldownTimer) {
            clearInterval(this.smsCooldownTimer);
        }
    },

    methods: {
        submit() {
            this.processing = true;
            this.res = null;

            this.$root.login(this.username, this.password, this.token, this.recoveryCode, this.useRecoveryCode, (res) => {
                this.processing = false;

                if (res.tokenRequired) {
                    this.tokenRequired = true;
                    this.twoFAMethod = res.method || "totp";
                } else {
                    this.res = res;
                }
            });
        },

        goBack() {
            this.tokenRequired = false;
            this.token = "";
            this.recoveryCode = "";
            this.useRecoveryCode = false;
            this.res = null;
        },

        requestSMSCode() {
            this.$root.getSocket().emit("requestLoginSMSCode", (res) => {
                if (res.ok) {
                    this.smsCooldown = 60;
                    this.smsCooldownTimer = setInterval(() => {
                        this.smsCooldown--;
                        if (this.smsCooldown <= 0) {
                            clearInterval(this.smsCooldownTimer);
                            this.smsCooldownTimer = null;
                        }
                    }, 1000);
                } else {
                    this.res = res;
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
.form-container {
    display: flex;
    align-items: center;
    padding-top: 40px;
    padding-bottom: 40px;
}

.form-floating {
    > label {
        padding-left: 1.3rem;
    }

    > .form-control {
        padding-left: 1.3rem;
    }
}

.form {
    width: 100%;
    max-width: 400px;
    padding: 15px;
    margin: auto;
    text-align: center;
}

.nav-tabs {
    border-bottom: 1px solid #dee2e6;

    .nav-link {
        color: #6c757d;
        font-size: 0.875rem;
        padding: 0.5rem 1rem;
        cursor: pointer;
        border: none;

        &.active {
            color: #0d6efd;
            border-bottom: 2px solid #0d6efd;
            background: none;
        }
    }
}
</style>
