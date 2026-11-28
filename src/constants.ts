export const PACKAGE_NAME = "teamclaws";
export const PACKAGE_VERSION = "2.0.41";
export const CLIENT_NAME = "teamclaws-cli";
export const CONTRACT_VERSION = 1;
export const OUTPUT_SCHEMA_VERSION = 1;

export const TEAMCLAWS_ORIGIN = "https://www.teamclaws.com";
export const API_RESOURCE = `${TEAMCLAWS_ORIGIN}/api/cli/v1`;
export const API_BASE = `${API_RESOURCE}/`;
export const API_V2_BASE = `${TEAMCLAWS_ORIGIN}/api/cli/v2/`;
export const OAUTH_CLIENT_ID = "teamclaws-cli";
export const OAUTH_DEVICE_AUTHORIZATION_URL = `${TEAMCLAWS_ORIGIN}/o/device-authorization/`;
export const OAUTH_TOKEN_URL = `${TEAMCLAWS_ORIGIN}/o/token/`;
export const OAUTH_REVOKE_URL = `${TEAMCLAWS_ORIGIN}/o/revoke_token/`;
export const OAUTH_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
export const ACCESS_TOKEN_MAX_LIFETIME_SECONDS = 600;

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const PAIRING_STATUS_TIMEOUT_MS = 5_000;
export const DEFAULT_RESPONSE_LIMIT_BYTES = 1_048_576;
export const MAX_DEVICE_NAME_LENGTH = 120;
export const MAX_CLIENT_LABEL_LENGTH = 120;
export const MAX_ERROR_MESSAGE_LENGTH = 300;
