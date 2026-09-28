#!/bin/sh
# kcode 安装器（POSIX）：本地 tar 包或 URL → sha256 校验 → 解包 ~/.kcode/releases/<name> → 启动器 ~/.kcode/bin/kcode
# 用法：install.sh <tar.gz 路径或 URL> [配套 latest.json 路径或 URL]
# 示例：curl -fsSL https://dist.example.com/kcode/install.sh | sh -s -- https://dist.example.com/kcode/latest.json
set -eu

SRC="${1:-}"
META="${2:-}"
KCODE_HOME="${KCODE_HOME:-$HOME/.kcode}"
BIN_DIR="$KCODE_HOME/bin"
REL_DIR="$KCODE_HOME/releases"

fail() { echo "✗ $1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "缺少 $1（安装 aborted）"; }
need node; need tar
[ "$(node -p 'process.version >= "v22" ? "ok" : "no"')" = "ok" ] || fail "需要 Node ≥22（当前 $(node -v)）"

[ -n "$SRC" ] || fail "用法：install.sh <tar.gz 路径或 URL> [latest.json 路径或 URL]"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# 取文件：本地直用，URL 走 curl
fetch() {
  case "$1" in
    http://*|https://*) need curl; curl -fsSL "$1" -o "$2" ;;
    *) cp "$1" "$2" ;;
  esac
}

# tar 包名（去 .tar.gz）即发行目录名：kcode-<ver>-<platform>
name() { basename "$1" .tar.gz; }

fetch "$SRC" "$TMP/pkg.tar.gz"

# sha256 校验：优先配套 .sha256 / latest.json；都缺则跳过但告警
SUM_SRC=""
case "$META" in
  http://*|https://*)
    fetch "$META" "$TMP/latest.json" 2>/dev/null || true
    [ -f "$TMP/latest.json" ] && SUM_SRC="$TMP/latest.json" ;;
  *.json)
    cp "$META" "$TMP/latest.json" 2>/dev/null || true
    [ -f "$TMP/latest.json" ] && SUM_SRC="$TMP/latest.json" ;;
  "")
    # 自动找同目录 .sha256（本地包场景）
    case "$SRC" in
      http://*|https://*) ;;
      *) [ -f "$SRC.sha256" ] && cp "$SRC.sha256" "$TMP/pkg.sha256" ;;
    esac ;;
esac
if [ -n "$SUM_SRC" ] && [ -f "$SUM_SRC" ]; then
  expected="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sha256' "$SUM_SRC" 2>/dev/null || true)"
  [ -n "$expected" ] || expected="$(grep -oE '^[0-9a-f]{64}' "$SUM_SRC" 2>/dev/null || true)"
fi
if [ -f "$TMP/pkg.sha256" ] && [ -z "${expected:-}" ]; then
  expected="$(grep -oE '^[0-9a-f]{64}' "$TMP/pkg.sha256")"
fi
if [ -n "${expected:-}" ]; then
  actual="$(node -e 'const c=require("crypto"),f=require("fs");console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TMP/pkg.tar.gz")"
  [ "$actual" = "$expected" ] || fail "sha256 校验失败（期望 $expected，实际 $actual）"
  echo "✓ sha256 校验通过"
else
  echo "⚠ 未提供校验源（.sha256 / latest.json），跳过校验"
fi

# 发行名取原始来源（本地路径或 URL 末段），不是 fetch 后的临时副本名
REL_NAME="$(name "$SRC")"
mkdir -p "$REL_DIR" "$BIN_DIR"
rm -rf "$REL_DIR/$REL_NAME"
tar -xzf "$TMP/pkg.tar.gz" -C "$REL_DIR"
[ -f "$REL_DIR/$REL_NAME/kcode.mjs" ] || fail "包结构异常：缺 kcode.mjs"
chmod +x "$REL_DIR/$REL_NAME/kcode.mjs" 2>/dev/null || true

# current 指针 + 启动器（经 node 运行；PATH 加 $BIN_DIR 即可用 kcode）
rm -rf "$REL_DIR/current"; ln -s "$REL_DIR/$REL_NAME" "$REL_DIR/current"
cat > "$BIN_DIR/kcode" <<EOF
#!/bin/sh
exec node "$REL_DIR/current/kcode.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/kcode"

echo "✓ 已安装 $REL_NAME → $REL_DIR/$REL_NAME"
echo "  启动器：$BIN_DIR/kcode（确保在 PATH 中：export PATH=\"$BIN_DIR:\$PATH\"）"
"$BIN_DIR/kcode" --version >/dev/null 2>&1 || true
echo "✓ 安装完成。运行：kcode \"你的问题\""
