# Thumbrella Clients 1.x changelog

## Development 

- Remove semi-internal BatchedClient  /typescript
- `tbrSetup` can be re invoked to modify the global config  /typescript
- `tbrSetup` properly registers browser side caches  /typescript
- Simplify urls for cache lookups  /typescript /python /rust
- Add Client.connect attribute  /typescript /python /rust


## 2.0.0 - 2026/10/11

- Add Result.pin url  /typescript /python /rust
- Update typescript to 7  /typescript
- Attestation for bundled js  /typescript
- Fix intermediate stream tracking  /typescript
- Improve connection errors with verify  /typescript /python /rust

## 1.4.0 - 2026/08/21

Rust streaming support completed. 

- Rust streaming implemented with dependency  /rust
- Rust integrate thumbnail binary buffer for loading into image libraries  /rust
- Rust Result 'media' property is not optional  /rust
- Remove legacy exported element.js, now use browser.js for everything  /typescript
- Align User-Agent to `thumbrella-<lang>/<major>.<minor>`  /typescript /python /rust
- Client batch size limited to 12 items  /typescript /python /rust
- Consistent connect string across implementations  /typescript /python /rust
