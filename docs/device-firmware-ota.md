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
