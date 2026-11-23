# Device firmware (OTA)

FilaMan stores ESP firmware images and lets devices (scales) update themselves over Wi-Fi. Several devices and several board types can run side by side; each board type is a *project*.

## Projects

| Project | Board |
| --- | --- |
| `filaman-scale-esp32` | ESP32 scale |
| `filaman-scale-esp32s3` | ESP32-S3 scale |

## Marker format

The firmware embeds an ASCII marker. FilaMan reads project and version from the first match:

```
FMFWINFO1:project=<project>;version=<version>;
```

`project` matches `[a-z0-9-]{1,64}`, `version` matches `[0-9A-Za-z.+-]{1,32}`. The image must start with byte `0xE9` (ESP image magic) and be at most 2 MiB (2,097,152 bytes), otherwise the upload is rejected (`400 invalid_firmware`, or `413`).

## Flow

1. An admin uploads the `.bin` under Admin > Devices > Firmware. The upload becomes the current version of its project. Uploading the same project and version again replaces the entry. An identical image under another version is rejected (`409 firmware_exists`).
2. The admin can set an older version as current (rollback) or delete non-current versions.
3. The device sends `firmware_version` and `firmware_project` with its heartbeat.
4. The device calls `GET /api/v1/devices/firmware/latest?project=<project>`, compares `version`, downloads `url` (relative path, resolve against the server base URL), verifies size and `sha256`, flashes and reboots.
5. The device reports via `POST /api/v1/devices/ota-report`; the result shows in the device list.

Files are stored in `DATA_DIR/firmware/<sha256>.bin` and removed when no entry references them.

## Device endpoints

All require `Authorization: Device <token>`.

| Endpoint | Description |
| --- | --- |
| `POST /api/v1/devices/heartbeat` | `{"ip_address", "firmware_version"?, "firmware_project"?}` |
| `GET /api/v1/devices/firmware/latest?project=<p>` | `{"project","version","size","sha256","url"}`; 404 without a current version |
| `GET /api/v1/devices/firmware/<sha256>.bin` | Image as `application/octet-stream` with `Content-Length` (not gzip-compressed) |
| `POST /api/v1/devices/ota-report` | `{"from_version","to_version","result":"started"\|"ok"\|"failed"\|"rolled_back","error"?}`; error is truncated to 255 characters |

## Admin endpoints

Permission `admin:devices_manage`.

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/admin/firmware` | List, sorted by project and date |
| `POST /api/v1/admin/firmware` | Multipart field `file`; 201 |
| `POST /api/v1/admin/firmware/{id}/current` | Make current for its project |
| `DELETE /api/v1/admin/firmware/{id}` | 204; `409 firmware_is_current` for the current version |
| `POST /api/v1/admin/firmware/github-import` | Load the latest GitHub release, see below; `502 github_unavailable` |

## GitHub import

`POST /api/v1/admin/firmware/github-import` (button "Load from GitHub" under Admin > Devices) reads
`https://api.github.com/repos/Fire-Devils/FilaMan-System-ESP32/releases/latest` and imports all
assets named `upgrade_filaman_firmware_[esp32s3_]v<version>.bin`; other assets (`filaman_full_*`,
`upgrade_filaman_website_*`) are ignored. Downloads are limited to 2 MB and to https hosts
`github.com`, `api.github.com` and `*.githubusercontent.com` (also across redirects).

The response is `{"release": "<tag>", "results": [{"asset", "status", "project", "version", "message"}]}`
with status `imported` (new, becomes current), `replaced` (same project+version, new image),
`exists` (identical image already stored, nothing is changed, so a deliberate rollback of
`is_current` stays), `skipped` (image larger than 2 MB, or no `FMFWINFO1` marker as in releases
up to 3.4.11) or `failed`.

The app setting `firmware_auto_import` (default off, toggle on the same page) runs the same
import 5 minutes after start and then every 6 hours, in the primary worker only. Errors are
logged and retried at the next run.

## Keep only the latest firmware

The app setting `firmware_keep_latest_only` (default off, toggle on the same page) limits the
stored images. Per project the `is_current` image and, additionally, the highest version among
the remaining images are kept; everything older is deleted (database row, and the file unless
another entry uses the same sha256). Projects without a current image are never touched and
the current image is never deleted. Pruning runs after an admin upload, after a GitHub import
(manual and automatic, once per release) and when the setting is switched on, but not on
set-current or delete. Example: with 3.5.0 and 3.5.1 (current), uploading 3.5.2 keeps 3.5.2
and 3.5.1; switching back to 3.5.1 keeps 3.5.1 and 3.5.2.

## Update hint

`GET /api/v1/admin/system/version-check` additionally returns `firmware_updates`: per project
`{project, latest_version, current_version, update_available}`. The latest versions are read
from the GitHub release assets (no download) and share the 24 h cache of the system version
check; `current_version` (the `is_current` image) and `update_available` are computed from the
database on every call. `update_available` is true if GitHub is newer or FilaMan has no image
for the project. If GitHub is unreachable the list is empty. The admin overview links to
`/admin/devices`, where a banner with an "Import now" button triggers the GitHub import above.
Nothing is imported automatically by the hint.

## Security

Images are not signed. Devices verify only the SHA-256 from the `latest` response and the
project marker, both served by the FilaMan server. Anyone who can spoof traffic between a
device and the server (especially over plain `http://`) could push their own firmware. This
is an accepted trade-off (decision 2026-11-23): FilaMan and its devices are meant to run on
the owner's own trusted network and must not be exposed to the internet. If that changes,
add offline-key signing (e.g. Ed25519 in CI, public key built into the firmware).
