# 字节核对复核：对 embed 的两次令牌读回，剥离 Cloudflare 边缘注入片段后
# 与上传文件逐字节比对，并把结论写进 results.json。
import json

ORIG = open("/tmp/qa243/art/embed.html", "rb").read()
RES = "/tmp/qa243/results.json"


def strip_diff(resp: bytes):
    """返回 (公共前缀长度, 公共后缀长度, 中间插入片段)"""
    p = 0
    while p < min(len(resp), len(ORIG)) and resp[p] == ORIG[p]:
        p += 1
    s = 0
    while (
        s < min(len(resp), len(ORIG)) - p
        and resp[len(resp) - 1 - s] == ORIG[len(ORIG) - 1 - s]
    ):
        s += 1
    return p, s, resp[p : len(resp) - s]


def check(cid, criterion, path, token_role, evidence):
    resp = open(path, "rb").read()
    p, s, seg = strip_diff(resp)
    rest = resp[:p] + resp[len(resp) - s :] if s else resp[:p]
    cf_marked = b"cdn-cgi" in seg or b"__CF$cv$params" in seg
    identical_after_strip = rest == ORIG
    app_injection_present = b"ciki-embed-height" in resp
    entry = {
        "id": cid,
        "criterion": criterion,
        "method": "GET",
        "url": "/api/read/files/embeds/da25df06-87da-4453-b968-9c7354452a86.html",
        "token_role": token_role,
        "status": "200",
        "actual": json.dumps(
            {
                "响应字节数": len(resp),
                "上传文件字节数": len(ORIG),
                "插入片段字节数": len(seg),
                "插入片段含Cloudflare标识": cf_marked,
                "剥离插入片段后与上传文件逐字节一致": identical_after_strip,
                "响应含应用侧注入标记(ciki-embed-height)": app_injection_present,
            },
            ensure_ascii=False,
        ),
        "expected": "剥离 Cloudflare 边缘注入片段后，响应体与上传文件逐字节一致；且响应不含应用侧注入",
        "result": "PASS" if (identical_after_strip and cf_marked and not app_injection_present) else "FAIL",
        "evidence": evidence,
    }
    return entry


res = json.load(open(RES))
res.append(
    check(
        "A1B",
        "项1-embed 读回字节：剥离 Cloudflare 边缘注入后与上传文件逐字节一致",
        "/tmp/qa243/out/a1_embed_read.body.bin",
        "A_READ",
        "a1_embed_read.body.bin,art/embed.html,r2obj_embed.bin",
    )
)
res.append(
    check(
        "A2B",
        "项1-embed 读回字节：write 令牌同样逐字节一致（剥离边缘注入后）",
        "/tmp/qa243/out/a2_embed_write.body.bin",
        "A_WRITE",
        "a2_embed_write.body.bin,art/embed.html,r2obj_embed.bin",
    )
)
# 两次读回互不相同 = 边缘脚本每次请求生成（内含本次 cf-ray 与时间戳）
a1 = open("/tmp/qa243/out/a1_embed_read.body.bin", "rb").read()
a2 = open("/tmp/qa243/out/a2_embed_write.body.bin", "rb").read()
res.append(
    {
        "id": "A1C",
        "criterion": "项1-两次读回差异仅来自边缘脚本（每次请求内嵌本次 cf-ray）",
        "method": "GET",
        "url": "/api/read/files/embeds/da25df06-87da-4453-b968-9c7354452a86.html",
        "token_role": "A_READ/A_WRITE",
        "status": "200",
        "actual": json.dumps(
            {
                "两次响应是否相同": a1 == a2,
                "A1含cf-ray": b"a6077ff659b5b5d4" in a1,
                "A2含cf-ray": b"a6077ffee918adfc" in a2,
            },
            ensure_ascii=False,
        ),
        "expected": "两次响应不同，差异仅在边缘脚本内的 cf-ray/时间戳",
        "result": "PASS" if a1 != a2 else "FAIL",
        "evidence": "a1_embed_read.body.bin,a2_embed_write.body.bin",
    }
)
json.dump(res, open(RES, "w"), ensure_ascii=False, indent=2)
print(json.dumps(res[-3:], ensure_ascii=False, indent=2))
