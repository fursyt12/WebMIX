# Packaging WebMIX

Everything the release workflow needs lives here, and every script also runs by
hand from a checkout. The three platform jobs produce:

| Job | Script | Artifacts |
| --- | --- | --- |
| Debian/Ubuntu | `deb/package-deb.sh <build-dir> <out-dir>` | `webmix_<version>_amd64.deb`, `webmix-dbgsym_<version>_amd64.ddeb` |
| Arch Linux | `arch/build-package.sh [out-dir]` | `webmix-<version>-1-x86_64.pkg.tar.zst` plus the pacman repository database (`webmix.db*`, `webmix.files*`) |
| Windows | `windows/package.ps1 -BuildDir build_x64 -OutDir dist` | `webmix-<version>-windows-x64.zip` |

`publish-release.sh <version> <dist-dir>` collects such a `dist/` directory,
writes a single `SHA256SUMS` and creates (or updates) the GitHub release with
`packaging/RELEASE_NOTES.md.in` as the body.

## Releasing

```bash
git tag 0.1.0
git push origin 0.1.0       # builds all three platforms and publishes the release
```

Tag without the `v` prefix: this repository keeps OBS's own CI workflows, and
those derive their version from the tag with `git describe`, which turns a
`v0.1.0` tag into the invalid CMake version `v0.1.0`. The release workflow itself
accepts both spellings.

`.github/workflows/release.yml` can also be started by hand (Actions → Release →
Run workflow) with a version and a `publish` switch; without `publish` it only
builds and uploads the workflow artifacts, which is the way to test a change to
the workflow itself.

## Building each package locally

### Arch Linux

```bash
cd packaging/arch
./build-package.sh ../../dist
```

`makepkg` refuses to run as root, and it needs network access for two reasons:
the PKGBUILD builds a tag of this repository (a GitHub tag *tarball* has no
submodules, so `prepare()` fetches the obs-websocket submodule), and
`--syncdeps` installs the build dependencies.

### Debian / Ubuntu

The build needs the distribution's development packages; the list is in
`.github/workflows/release.yml` (it is the upstream OBS list minus VLC, which
this build disables).

```bash
sudo apt-get install -y --no-install-recommends <the list from the workflow>
cmake --preset ubuntu-ci -DOBS_VERSION_OVERRIDE=0.1.0 -DWEBMIX_PACKAGE_NAME=webmix \
  -DENABLE_BROWSER=OFF -DENABLE_SCRIPTING=OFF -DENABLE_VLC=OFF
cmake --build build_ubuntu --parallel
packaging/deb/package-deb.sh build_ubuntu dist
```

The package name comes from `-DWEBMIX_PACKAGE_NAME=webmix`; without it CPack
still produces `obs-studio`, which is what an unforked build does.

### Windows

```powershell
cmake --preset windows-ci-x64 -DOBS_VERSION_OVERRIDE=0.1.0 -DWEBMIX_PACKAGE_NAME=webmix `
  -DENABLE_BROWSER=OFF -DENABLE_SCRIPTING=OFF
cmake --build --preset windows-x64 --config RelWithDebInfo --parallel
cmake --install build_x64 --prefix build_x64/install --config RelWithDebInfo
pwsh -File packaging/windows/package.ps1 -BuildDir build_x64 -OutDir dist
```

The presets download the prebuilt obs-deps and Qt6 packages listed in
`CMakePresets.json`, so a Windows machine only needs Visual Studio and CMake.

## The pacman repository

`arch/add-repo.sh` is the user-facing half: it appends

```ini
[webmix]
SigLevel = Optional TrustAll
Server = https://github.com/fursyt12/WebMIX/releases/latest/download
```

to `/etc/pacman.conf`, runs `pacman -Sy` and (with `--install`) installs the
package. `--remove` undoes the configuration change, `--dry-run` only prints.

GitHub release assets cannot be symlinks, so `build-package.sh` copies
`webmix.db.tar.gz` to `webmix.db` (and the same for `webmix.files`): pacman
accepts either name and only follows the redirect to the release asset.

The repository is unsigned on purpose - the workflow has no maintainer key - and
`TrustAll` means pacman will not question the packages. Users who care should
check `SHA256SUMS` from the release or build the PKGBUILD themselves.
