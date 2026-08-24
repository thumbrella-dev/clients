// src/version.ts
//
// Major.minor client version reported in the User-Agent header as
// `thumbrella-ts/<major>.<minor>`. Keep this in sync with the `version`
// field in package.json (the patch number is intentionally omitted from the
// agent string). scripts/bundle.ts verifies the two stay in sync when it
// builds the CDN bundle.
export const CLIENT_MAJOR_MINOR = "1.4";
