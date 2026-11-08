# FilaMan plugin catalog

Open **Admin → Plugins → Browse Plugins** to search the catalog, filter by installation or update status, and check which FilaMan version a release requires. **Upload ZIP** remains available for manual installs.

Driver changes reconnect printers that use that driver. Changes to plugin routes and complete backup recovery can reload Gunicorn workers and temporarily interrupt printer connections.

The first catalog uses the four Fire-Devils ZIPs already available from the FilaMan registry. Installed built-in plugins appear in the main plugin table.

## Submit a plugin

Attach the installable plugin ZIP to a tagged release in your public GitHub repository. Copy the direct link to the ZIP under **Assets**. It should look like `https://github.com/owner/repo/releases/download/v1.2.3/plugin.zip`.

Use the [plugin submission form](https://github.com/Fire-Devils/filaman-system/issues/new?template=plugin-submission.yml) or propose an entry in a pull request. Include the public source repository, release ZIP link, plugin name and version, publisher, license, short description, setup requirements, minimum FilaMan version, and versions tested.

Use Store or Deflate ZIP compression. The ZIP can be up to 10 MB, with at most 100 MB unpacked and 1 MB per file.

## Publish a catalog change

1. Review the code and dependencies in the submitted ZIP. Test that ZIP on the oldest supported FilaMan version. Use a new plugin version when the contents change.
2. Record the approved ZIP link as `github_release_url` and its SHA-256 in [catalog-v1.json](catalog-v1.json). For an update, change the version, URL, and SHA-256 to point to the newly approved asset. Existing Fire-Devils entries use `zip_path` and can switch to `github_release_url` when their maintainers publish reviewed ZIPs on GitHub.
3. Open a catalog PR. The **Plugin catalog** check validates the entries, downloads the selected ZIPs, checks their hashes, and runs the same archive checks as the installer.
4. Publish to Fire-Devils/filaman-system's `main` branch after maintainer review. Running builds fetch the updated list when admins reopen **Browse Plugins** or check for updates. A catalog merge uses the existing FilaMan version and image.

Limit merges to catalog maintainers. Configure protected branch review and require the catalog check on catalog PRs. To withdraw a release, remove its entry. If it was exposed to older clients, remove it from the legacy directory listing as well.
