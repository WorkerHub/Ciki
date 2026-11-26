#!/bin/bash
# Ciki #243 生产真跑验收主脚本（只读为主；上传仅作验收用，测完删）。
# 令牌明文只从 /tmp/qa243/tokens.env 读，不打印、不落证据。
set -uo pipefail

BASE="https://ciki.oneboy.app"
ART=/tmp/qa243/art
OUT=/tmp/qa243/out
mkdir -p "$OUT"
rm -f "$OUT"/*
source /tmp/qa243/tokens.env

RESULTS=/tmp/qa243/results.json
: > "$RESULTS.json.tmp"
echo "[]" > "$RESULTS.json.tmp"

sha() { shasum -a 256 "$1" | awk '{print $1}'; }
ctype() { grep -i '^content-type:' "$1" | head -1 | sed 's/^[Cc]ontent-[Tt]ype: *//' | tr -d '\r'; }
status_of() { grep -i '^HTTP/' "$1" | tail -1 | awk '{print $2}'; }

rec() { # rec id criterion method path role status actual expected pass evidence
  python3 - "$RESULTS.json.tmp" "$@" <<'PY'
import json,sys
path=sys.argv[1]
id_,criterion,method,url,role,status,actual,expected,ok,evidence=sys.argv[2:12]
data=json.load(open(path))
data.append({
 "id":id_,"criterion":criterion,"method":method,"url":url,"token_role":role,
 "status":status,"actual":actual,"expected":expected,
 "result":"PASS" if ok=="1" else "FAIL","evidence":evidence})
json.dump(data,open(path,"w"),ensure_ascii=False,indent=2)
PY
}

hit() { # hit id token method path [uploadfile]
  local id="$1" tok="$2" method="$3" path="$4" file="${5:-}"
  local h="$OUT/$id.headers.txt" b="$OUT/$id.body.bin"
  local args=(-s --noproxy '*' --path-as-is -X "$method" -D "$h" -o "$b" -w '%{http_code}')
  [ -n "$tok" ] && args+=(-H "Authorization: Bearer $tok")
  if [ -n "$file" ]; then
    args+=(-F "file=@$file")
  fi
  curl "${args[@]}" "$BASE$path"
  echo "$id $(status_of "$h")" >&2
}

echo "### 1) 上传三个验收物（A 的 write 令牌）"
hit up_embed "$A_WRITE" POST /api/write/files/embeds "$ART/embed.html"
hit up_image "$A_WRITE" POST /api/write/files "$ART/image.png"
hit up_scene "$A_WRITE" POST /api/write/files "$ART/scene.json"

EMBED_KEY=$(python3 -c "import json;print(json.load(open('$OUT/up_embed.body.bin'))['key'])")
IMAGE_KEY=$(python3 -c "import json;print(json.load(open('$OUT/up_image.body.bin'))['key'])")
SCENE_KEY=$(python3 -c "import json;print(json.load(open('$OUT/up_scene.body.bin'))['key'])")
echo "keys: $EMBED_KEY | $IMAGE_KEY | $SCENE_KEY" | tee /tmp/qa243/keys.txt

SHA_EMBED=$(sha "$ART/embed.html")
SHA_IMAGE=$(sha "$ART/image.png")
SHA_SCENE=$(sha "$ART/scene.sanitized.json")

echo "### 2) 验收项 1：同主人 read/write 令牌读 embed"
hit a1_embed_read "$A_READ" GET "/api/read/files/$EMBED_KEY"
st=$(status_of "$OUT/a1_embed_read.headers.txt"); ct=$(ctype "$OUT/a1_embed_read.headers.txt"); bs=$(sha "$OUT/a1_embed_read.body.bin")
if [ "$st" = "200" ] && [ "$bs" = "$SHA_EMBED" ] && cmp -s "$OUT/a1_embed_read.body.bin" "$ART/embed.html"; then ok=1; else ok=0; fi
rec A1 "项1-同主人read令牌读embed" GET "/api/read/files/$EMBED_KEY" A_READ "$st" \
  "status=$st content-type=$ct body_sha256=$bs" "200 + body 与上传文件逐字节一致" "$ok" "a1_embed_read.headers.txt,a1_embed_read.body.bin"

hit a2_embed_write "$A_WRITE" GET "/api/read/files/$EMBED_KEY"
st=$(status_of "$OUT/a2_embed_write.headers.txt"); ct=$(ctype "$OUT/a2_embed_write.headers.txt"); bs=$(sha "$OUT/a2_embed_write.body.bin")
if [ "$st" = "200" ] && [ "$bs" = "$SHA_EMBED" ] && cmp -s "$OUT/a2_embed_write.body.bin" "$ART/embed.html"; then ok=1; else ok=0; fi
rec A2 "项1-同主人write令牌读embed" GET "/api/read/files/$EMBED_KEY" A_WRITE "$st" \
  "status=$st content-type=$ct body_sha256=$bs" "200 + body 与上传文件逐字节一致" "$ok" "a2_embed_write.headers.txt,a2_embed_write.body.bin"

echo "### 3) 验收项 2：他人令牌读同一 key → 404 File not found"
hit b1_embed_other_read "$B_READ" GET "/api/read/files/$EMBED_KEY"
st=$(status_of "$OUT/b1_embed_other_read.headers.txt"); body=$(cat "$OUT/b1_embed_other_read.body.bin")
if [ "$st" = "404" ] && [ "$body" = '{"error":"File not found"}' ]; then ok=1; else ok=0; fi
rec B1 "项2-他人read令牌读embed" GET "/api/read/files/$EMBED_KEY" B_READ "$st" \
  "status=$st body=$body" "404 + {\"error\":\"File not found\"}" "$ok" "b1_embed_other_read.headers.txt,b1_embed_other_read.body.bin"

hit b2_embed_other_write "$B_WRITE" GET "/api/read/files/$EMBED_KEY"
st=$(status_of "$OUT/b2_embed_other_write.headers.txt"); body=$(cat "$OUT/b2_embed_other_write.body.bin")
if [ "$st" = "404" ] && [ "$body" = '{"error":"File not found"}' ]; then ok=1; else ok=0; fi
rec B2 "项2-他人write令牌读embed（附加：kind 不影响归属校验）" GET "/api/read/files/$EMBED_KEY" B_WRITE "$st" \
  "status=$st body=$body" "404 + {\"error\":\"File not found\"}" "$ok" "b2_embed_other_write.headers.txt,b2_embed_other_write.body.bin"

echo "### 4) 验收项 3：回归——图片 key / 画布场景 JSON key 令牌读回"
hit r1_image "$A_READ" GET "/api/read/files/$IMAGE_KEY"
st=$(status_of "$OUT/r1_image.headers.txt"); ct=$(ctype "$OUT/r1_image.headers.txt"); bs=$(sha "$OUT/r1_image.body.bin")
if [ "$st" = "200" ] && [ "$bs" = "$SHA_IMAGE" ] && cmp -s "$OUT/r1_image.body.bin" "$ART/image.png"; then ok=1; else ok=0; fi
rec R1 "项3-图片key令牌读回（改前一致）" GET "/api/read/files/$IMAGE_KEY" A_READ "$st" \
  "status=$st content-type=$ct body_sha256=$bs" "200 + content-type=image/png + 字节与上传一致" "$ok" "r1_image.headers.txt,r1_image.body.bin"

hit r2_scene "$A_READ" GET "/api/read/files/$SCENE_KEY"
st=$(status_of "$OUT/r2_scene.headers.txt"); ct=$(ctype "$OUT/r2_scene.headers.txt"); bs=$(sha "$OUT/r2_scene.body.bin")
if [ "$st" = "200" ] && [ "$bs" = "$SHA_SCENE" ] && cmp -s "$OUT/r2_scene.body.bin" "$ART/scene.sanitized.json"; then ok=1; else ok=0; fi
rec R2 "项3-画布场景JSON key令牌读回（改前一致）" GET "/api/read/files/$SCENE_KEY" A_READ "$st" \
  "status=$st content-type=$ct body_sha256=$bs" "200 + content-type=application/json + 字节与消毒后落盘对象一致" "$ok" "r2_scene.headers.txt,r2_scene.body.bin"

echo "### 4b) 读回字节 vs R2 落盘对象字节（三方一致）"
/tmp/qa243/r2.sh get "$EMBED_KEY" "$OUT/r2obj_embed.bin" > "$OUT/r2obj_embed.status.txt" 2>&1
/tmp/qa243/r2.sh get "$IMAGE_KEY" "$OUT/r2obj_image.bin" > "$OUT/r2obj_image.status.txt" 2>&1
/tmp/qa243/r2.sh get "$SCENE_KEY" "$OUT/r2obj_scene.bin" > "$OUT/r2obj_scene.status.txt" 2>&1
for pair in "embed:$EMBED_KEY:$OUT/a1_embed_read.body.bin:$OUT/r2obj_embed.bin" "image:$IMAGE_KEY:$OUT/r1_image.body.bin:$OUT/r2obj_image.bin" "scene:$SCENE_KEY:$OUT/r2_scene.body.bin:$OUT/r2obj_scene.bin"; do
  name=$(echo "$pair" | cut -d: -f1); key=$(echo "$pair" | cut -d: -f2); api="$OUT/api_$name.bin"; r2f="$OUT/r2_$name.bin"
  cp "$(echo "$pair" | cut -d: -f3)" "$api"; cp "$(echo "$pair" | cut -d: -f4)" "$r2f"
  st=$(cat "$OUT/r2obj_$name.status.txt" | tr -dc '0-9')
  if [ "$st" = "200" ] && cmp -s "$api" "$r2f"; then ok=1; else ok=0; fi
  rec "R2OBJ_$name" "项3-令牌读回字节与R2落盘对象逐字节一致" GET "/api/read/files/$key" A_READ "$st" \
    "r2_get_status=$st api_sha=$(sha "$api") r2_sha=$(sha "$r2f")" "R2 存的对象与 API 返回字节完全相同" "$ok" "api_$name.bin,r2_$name.bin"
done

echo "### 5) 验收项 3：乱拼形状仍 404"
i=0
while IFS= read -r badkey; do
  [ -z "$badkey" ] && continue
  i=$((i+1))
  id="s$i"
  hit "$id" "$A_READ" GET "/api/read/files/$badkey"
  st=$(status_of "$OUT/$id.headers.txt"); body=$(cat "$OUT/$id.body.bin")
  if [ "$st" = "404" ] && [ "$body" = '{"error":"File not found"}' ]; then ok=1; else ok=0; fi
  rec "$id" "项3-乱拼形状 404" GET "/api/read/files/$badkey" A_READ "$st" \
    "status=$st body=$body" "404 + {\"error\":\"File not found\"}" "$ok" "$id.headers.txt,$id.body.bin"
done <<EOF
embeds/11111111-2222-4333-8444-555555555555.png
unknown/11111111-2222-4333-8444-555555555555.html
pages/11111111-2222-4333-8444-555555555555.html
embeds/11111111-2222-4333-8444-55555555555A.html
embeds/not-a-uuid.html
embeds/11111111-2222-4333-8444-555555555555.html.exe
embeds/..%2f..%2f..%2fetc%2fpasswd
embeds/99999999-8888-4777-8666-555555555555.html
EOF

echo "### 6) 验收项 4：公开文档与新行为一致"
hit d1_guide "" GET /api/public/agent-guide
st=$(status_of "$OUT/d1_guide.headers.txt"); ct=$(ctype "$OUT/d1_guide.headers.txt")
guide="$OUT/d1_guide.body.bin"
guide_ok=1
grep -q 'embeds/<uuid>.html' "$guide" || guide_ok=0
grep -q '读取文件（支持正文图片、画布场景 JSON 及 Embed 嵌入 HTML' "$guide" || guide_ok=0
grep -q '契约版本：1.0.0' "$guide" || guide_ok=0
rec D1 "项4-agent-guide 描述与新行为一致" GET /api/public/agent-guide public "$st" \
  "status=$st content-type=$ct 含embeds形状句=$(grep -c 'embeds/<uuid>.html' "$guide") 契约版本行=$(grep -c '契约版本：1.0.0' "$guide")" \
  "200 + §4.3 含 embed 形状与新描述 + 契约版本 1.0.0" "$guide_ok" "d1_guide.headers.txt,d1_guide.body.bin"

hit d2_openapi "" GET /api/openapi.json
st=$(status_of "$OUT/d2_openapi.headers.txt")
python3 - "$OUT/d2_openapi.body.bin" "$RESULTS.json.tmp" "$st" <<'PY'
import json,sys
spec=json.load(open(sys.argv[1]))
path=sys.argv[3]
res=json.load(open(sys.argv[2]))
desc=spec["paths"]["/api/read/files/{key}"]["get"]["description"]
pdesc=spec["paths"]["/api/read/files/{key}"]["get"]["parameters"][0]["description"]
pub=spec["components"]["schemas"]["PublicInfoResponse"]
ok = ("Embed" in desc and "embeds/<uuid>.html" in pdesc
      and "repositoryUrl" not in json.dumps(spec)
      and pub["required"]==["name","version","openapi","agentGuide"]
      and set(pub["properties"].keys())=={"name","version","openapi","agentGuide"})
res.append({"id":"D2","criterion":"项4-openapi.json 端点描述与新行为一致、无 repositoryUrl",
  "method":"GET","url":"/api/openapi.json","token_role":"public","status":path,
  "actual":json.dumps({"readFilesDesc":desc,"keyParamDesc":pdesc,"publicInfoRequired":pub["required"],
    "publicInfoProps":sorted(pub["properties"].keys()),
    "repositoryUrl出现次数":json.dumps(spec,ensure_ascii=False).count("repositoryUrl"),
    "openapi_version":spec.get("info",{}).get("version")},ensure_ascii=False),
  "expected":"描述含 Embed；key 参数含 embeds/<uuid>.html；全文档无 repositoryUrl；PublicInfoResponse 仅 4 字段",
  "result":"PASS" if ok else "FAIL","evidence":"d2_openapi.headers.txt,d2_openapi.body.bin"})
json.dump(res,open(sys.argv[2],"w"),ensure_ascii=False,indent=2)
PY

echo "### 7) 验收项 5：/api/public 字段"
hit d3_public "" GET /api/public
st=$(status_of "$OUT/d3_public.headers.txt")
python3 - "$OUT/d3_public.body.bin" "$RESULTS.json.tmp" "$st" <<'PY'
import json,sys
body=open(sys.argv[1]).read()
obj=json.loads(body)
res=json.load(open(sys.argv[2]))
status=sys.argv[3]
keys=sorted(obj.keys())
ok = (keys==["agentGuide","name","openapi","version"]
      and "repositoryUrl" not in obj
      and obj["name"]=="Ciki"
      and obj["openapi"]=="/api/openapi.json"
      and obj["agentGuide"]=="/api/public/agent-guide"
      and obj["version"].endswith("-9035f6e"))
res.append({"id":"D3","criterion":"项5-/api/public 字段逐项一致且无 repositoryUrl",
  "method":"GET","url":"/api/public","token_role":"public","status":status,
  "actual":json.dumps({"raw":obj,"keys":keys},ensure_ascii=False),
  "expected":"仅 name/version/openapi/agentGuide；name=Ciki；openapi=/api/openapi.json；agentGuide=/api/public/agent-guide；version 短哈希=9035f6e",
  "result":"PASS" if ok else "FAIL","evidence":"d3_public.headers.txt,d3_public.body.bin"})
json.dump(res,open(sys.argv[2],"w"),ensure_ascii=False,indent=2)
PY

mv "$RESULTS.json.tmp" "$RESULTS"
echo "### 结果汇总"
python3 - "$RESULTS" <<'PY'
import json,sys
res=json.load(open(sys.argv[1]))
fails=[r for r in res if r["result"]!="PASS"]
for r in res:
    print(("PASS" if r["result"]=="PASS" else "FAIL"), r["id"], "|", r["criterion"], "|", r["actual"][:150])
print("---- 合计 %d 项，FAIL %d 项" % (len(res), len(fails)))
PY
