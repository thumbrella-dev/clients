# Thumbrella Clients 1.x changelog

## Development

## 1.4.0 - 2026/08/21

Rust streaming support completed. 

- Rust streaming implemented with dependency  /rust
- Rust integrate thumbnail binary buffer for loading into image libraries  /rust
- Rust Result 'media' property is not optional  /rust
- Remove legacy exported element.js, now use browser.js for everything  /typescript
- Align User-Agent to `thumbrella-<lang>/<major>.<minor>`  /typescript /python /rust
- Client batch size limited to 12 items  /typescript /python /rust
- Consistent connect string across implementations  /typescript /python /rust
