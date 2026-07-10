# Thumbrella Clients

<img src="thumbrella.png" alt="Thumbrella Logo" width="224" height="224" align="right" />

Client libraries and framework components for the
[Thumbrella](https://thumbrella.dev) thumbnail API.

Thumbrella is an open-source server that generates fast, cached thumbnails from
over 100 file formats of images, video, documents, 3D models, and more. It can be
self-hosted or used via Thumbrella Cloud.

## Packages

Each subdirectory is independently versioned and published to its language
registry. 

| Directory              | Repository  | Package     | Status      |
|------------------------|-------------|-------------|-------------|
| [typescript/](./typescript) | `npm`  | [@thumbrella/client](https://www.npmjs.com/package/@thumbrella/client) | Prerelease  |
| [python/](./python)    | `PyPI`      | [thumbrella-client](https://pypi.org/project/thumbrella-client/) | Prerelease  |
| [rust/](./rust)        | `Crates.io` | [thumbrella-client](https://crates.io/crates/thumbrella-client) | Prerelease  |
| [react/](./react)      | `npm`       | [@thumbrella/react](https://www.npmjs.com/package/@thumbrella/react) | ~~Unreleased~~  |
| [astro/](./astro)      | `npm`       | [@thumbrella/astro](https://www.npmjs.com/package/@thumbrella/astro) | ~~Unreleased~~  |

See each subdirectory's README for install instructions, quickstart examples,
and API details.

The [project client documentation](https://thumbrella.dev/docs/client/) contains further information on working
with Thumbrella servers.

All clients use a connection string to define a server and authentication.
By default they all read the `$TBR_CONNECT` environment variable. They also
accept a connection string argument.

## License

Apache-2.0. See [LICENSE](./LICENSE).
