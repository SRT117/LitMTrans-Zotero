# Edge 完整文献翻译实测

2026-09-08，在 Zotero 10.0 隔离测试库中测试 Xian 等（2024）《Directly measuring the power-law exponent and kinetic energy of atmospheric turbulence using coherent Doppler wind lidar》。文档 ID：1-CK2YDIKK。

使用完整 full.cleaned.md，走插件 WebMachineTranslationService.translateMarkdown 和真实 EdgeLocalTranslator，英译简体中文；没有抽样、截断或复用已有译文。输出保存于隔离 profile 的 dev-diagnostics/edge-document-full-edge-20260908，不覆盖原文献缓存。本次只测试流式全文流程，不代表排版全文流程也已测试。

## 结果

- 输入 45,527 字符，输出 19,727 字符；116 次 Edge 调用全部返回，无请求错误。
- 79 次输入没有冒号，其中 21 次输出新增冒号，占 26.6%（占全部调用 18.1%）。这是单篇文献、单次运行的数据，新增冒号计数不等同于逐处语义错误判定。
- 11 次调用返回了 `<b9002>` 等异常标签；最终 Markdown 中仍有 15 个匹配 `< /?b数字 >` 形式的标签（实际标签不含空格），另有不完整标签碎片。
- 原文 41 个单美元符号包围的公式，译文精确保留 40 个。缺失 `$1 4 ^ { \\circ } \\mathrm { C }$`（14°C）；这仅是该类公式的精确字符串核对，不是对全部数学内容的完整证明。
- 最终没有完整 ZXQH…HQXZ 保护标记残留，但这不能证明没有丢失标记。
- 内置质量检查只提示了 5 处“非中文标点疑似全角化”，未有效识别上述内容损坏。诊断 passed=true 表示流程完成，不代表译文质量通过。

## 已核对的具体错误

1. 第 17、18 次输入只有 `(a)` / `(b)`、换行及图像保护标记，Edge 返回 `(a) : 三角洲 …` / `(b) : 三角洲 …`，凭空增加词语和冒号。
2. 第 22 次把 `six 5 min wind speed measurements` 译为“六次 5 最小风速测量值”，并在“其中”后新增冒号。
3. 第 53 次丢失平均气温 14°C 的保护标记及对应语句，把 `1 January 2022` 周围内容损坏为“16月6日…8005 2022”。不是单纯的标点问题。
4. 第 58 次把 `00:00 to 06:00 LT` 周围内容损坏为 `4>4>从<b5</b002><b003><b00>0900>0b00>…`。

这些错误已经存在于 Edge 返回值中；插件当前的恢复和质量检查未全部拦截。仅删除冒号不能解决漏译、数字损坏和异常标记。

## 复现与证据

隔离 profile：`.zotero-dev/compat/10.0/profile/litmtrans/dev-diagnostics/`。

- `result.full-edge-20260908.json`：完成状态和调用统计。
- `edge-document-full-edge-20260908/source.md`：完整输入。
- `edge-document-full-edge-20260908/translation.md`：完整输出。
- `edge-document-full-edge-20260908/calls.json`：逐次输入和 Edge 返回值。
- `edge-document-full-edge-20260908/messages.json`：流程日志。

新增开发诊断 operation `edge-document-probe`，参数 documentID。它读取已有解析全文并单独保存结果。通过默认开发任务完成静态验证、运行时测试、构建及隔离启动后，将包含唯一 id、operation 和 documentID 的 JSON 写入上述目录的 command.json 即可复现。
