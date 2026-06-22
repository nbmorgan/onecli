import { validateGoogleDrivePolicy } from "./google-drive-policy";

export interface PolicyValidator {
  validate(
    organizationId: string,
    provider: string,
    metadata: Record<string, unknown> | null,
    policy: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Default validator. Upstream ships this as a no-op (provider-specific
 * validation is a cloud concern). This fork validates the providers it
 * supports for self-hosted so a malformed `sessionPolicy` is rejected at save
 * time instead of being silently ignored by the gateway. The cloud build still
 * overrides this via {@link initPolicyValidator}.
 */
const defaultPolicyValidator: PolicyValidator = {
  validate: async (_organizationId, provider, _metadata, policy) => {
    if (provider === "google-drive") validateGoogleDrivePolicy(policy);
  },
};

let _policyValidator: PolicyValidator = defaultPolicyValidator;

export const initPolicyValidator = (v: PolicyValidator) => {
  _policyValidator = v;
};

export const getPolicyValidator = (): PolicyValidator => _policyValidator;
