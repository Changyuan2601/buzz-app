# Prepare Buzz's Goose storage without changing the terminal's environment.
set -eu
if [ "$(uname)" = Darwin ]; then
  buzz_home="$HOME/Library/Application Support/Buzz/goose-home"
else
  buzz_home="${XDG_DATA_HOME:-$HOME/.local/share}/buzz/goose-home"
fi
# Goose uses the Unix config path on macOS too (etcetera's XDG strategy).
case "${GOOSE_PATH_ROOT:-}" in
  /*) shared="$GOOSE_PATH_ROOT/config" ;;
  *) shared="${XDG_CONFIG_HOME:-$HOME/.config}/goose" ;;
esac
mkdir -p "$shared"
shared=$(cd "$shared" && pwd -P)
mkdir -p -m 700 "$buzz_home"
buzz_home=$(cd "$buzz_home" && pwd -P)
[ "$buzz_home/config" != "$shared" ] ||
  { echo "Buzz's Goose home must differ from the shared one" >&2; exit 1; }
# Share provider definitions and file/keyring settings, never the session DB.
[ -e "$buzz_home/config" ] || [ -L "$buzz_home/config" ] ||
  ln -sn "$shared" "$buzz_home/config" 2>/dev/null || true
[ "$(readlink "$buzz_home/config")" = "$shared" ] ||
  { echo "Buzz's Goose setup conflicts with $buzz_home/config" >&2; exit 1; }
printf '%s\n' "$buzz_home"
