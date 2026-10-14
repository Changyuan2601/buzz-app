# Buzz's Pi host, on this computer's Node, with its own copy of Pi's
# packages, apart from any `pi` the user installed. The plugin runs it as
# `bash -c` (see `start` in pi.ts) with HOST PACKAGE LOCK: it installs the
# packages LOCK pins, once, then runs the host source HOST with Node.
set -eu

# Shared by every Buzz build on this computer, so there is one install of
# each set of packages, and each agent's storage is in one place.
if [ "$(uname)" = Darwin ]; then
  dir="$HOME/Library/Application Support/Buzz/pi"
else
  dir="${XDG_DATA_HOME:-$HOME/.local/share}/buzz/pi"
fi

# Pi's packages need Node 22.19 for `node:sqlite`. The app's PATH has
# Homebrew's folders; a version manager's are set up by a login shell.
usable() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' 2>/dev/null
}
node=$(command -v node || true)
usable "$node" ||
  node=$("${SHELL:-/bin/sh}" -lc 'command -v node' </dev/null 2>/dev/null || true)
usable "$node" || {
  echo "Pi needs Node.js 22.19 or later. Install it from nodejs.org or with Homebrew, then try again." >&2
  exit 127
}

host="$1" package="$2" lock="$3"
# A folder for each set of packages, named by what pins them, so a build
# that pins others installs its own beside this one.
sum=$(printf '%s\n%s' "$package" "$lock" |
  (shasum -a 256 2>/dev/null || sha256sum) | cut -c1-16)
deps="$dir/deps/$sum"
if [ ! -d "$deps" ]; then
  echo "Installing Pi's packages…" >&2
  PATH="$(dirname "$node"):$PATH"
  command -v npm >/dev/null || { echo "Pi needs npm to install its packages" >&2; exit 127; }
  # Each install has its own folder, so two Buzz builds installing at once
  # do not write over each other, and a stopped one leaves nothing.
  part="$dir/deps/.$sum.$$"
  trap 'rm -rf "$part"' EXIT
  trap 'exit 143' INT TERM
  mkdir -p "$part"
  printf '%s' "$package" >"$part/package.json"
  printf '%s' "$lock" >"$part/package-lock.json"
  # Exactly what the lock pins, each package checked against its hash, from
  # the registry npm is set up for. Their install scripts do not run.
  npm ci --prefix "$part" --ignore-scripts --omit=dev --no-audit --no-fund \
    --loglevel=error >&2
  # A rename, so a host starting now sees no folder or a whole one. It fails
  # when another build's rename came first, and this copy is removed.
  "$node" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' \
    "$part" "$deps" 2>/dev/null || rm -rf "$part"
  trap - EXIT INT TERM
  # Folders no build has started for a month are old builds' packages.
  find "$dir/deps" -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf {} + 2>/dev/null || true
fi
touch "$deps"
cd "$deps"
BUZZ_PI_HOST=1 exec "$node" --disable-warning=ExperimentalWarning \
  --input-type=module -e "$host" "$dir"
