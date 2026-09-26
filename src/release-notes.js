(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};

  // 发布新版本时，在 ReleaseNotes 中增加或修改对应版本的条目。
  LitMTrans.StartupContent = Object.freeze({
    welcome: Object.freeze({
      title: "欢迎使用LitMTrans",
      paragraphs: Object.freeze([
        "LitMTrans是一个免费的开源项目。项目本身免费；日常使用网页模式时，翻译和问答也免费。（取决于Deepseek官方）",
        "LitMTrans使用MinerU进行文献结构化解析，因此首次使用前需要自行配置MinerU令牌。目前该服务由官方免费提供，官方目前声称每天有1000页快速解析额度，超出后进入排队。",
        "程序内置DeepSeek网页模式，扫码登录后即可使用官方免费问答。若需要使用其他AI服务，可以切换到API模式；API模式需要自行配置API密钥，费用由用户自行承担，LitMTrans本身不收取任何费用。"
      ]),
      calloutTitle: "开始使用",
      calloutText: "新用户只需先配置免费的MinerU令牌；默认网页模式无需配置API。"
    })
  });

  LitMTrans.ReleaseNotes = Object.freeze({
    "2.1.0": Object.freeze({
      title: "LitMTrans 2.1.0",
      entries: Object.freeze([
        Object.freeze({
          title: "AI助手连接（MCP服务）",
          detail: "支持ClaudeCode、Cursor、Codex、Trae、Workbuddy等AI客户端直接连接Zotero；可自动多源检索论文、查找并下载PDF，整理文献综述与原文证据链。"
        }),
        Object.freeze({
          title: "DeepSeek官方网页模式",
          detail: "内置官方网页端，扫码登录后即可免费进行全文翻译和文献对话，无需API；支持将全文正文或页面高清截图一键发给AI。"
        }),
        Object.freeze({
          title: "知网CAJ格式文献支持",
          detail: "内置本地WebAssembly转换，双击即可将.caj、.kdh等知网格式转为标准PDF进行解析和排版翻译（部分C8格式不支持）。"
        }),
        Object.freeze({
          title: "插件存储与数据管理",
          detail: "新增可视化存储面板，可清晰查看缓存占用，支持一键清理已删除文献的遗留数据、清空临时切图，并可双击进入本地文件目录。"
        }),
        Object.freeze({
          title: "常用提示词面板",
          detail: "工具栏新增提示词库，支持保存、编辑常用提示词，一键复制或填入对话框。"
        }),
        Object.freeze({
          title: "公式与排版优化",
          detail: "修复了部分文献公式偏小、右侧序号错位的问题；加固了排版翻译约束，避免段落语句跨块搬运；修复中译英重译问题。"
        }),
        Object.freeze({
          title: "思维导图持久化",
          detail: "生成的思维导图和流程图自动保存在本地；扩展支持从普通Markdown标题大纲中直接渲染图表。"
        }),
        Object.freeze({
          title: "导出功能完善",
          detail: "新增“导出排版原文为PDF”，导出的PDF会自动挂载回当前条目；支持完整导出带图Markdown及独立表格。"
        }),
        Object.freeze({
          title: "国内加速更新通道",
          detail: "集成Gitee与国内加速镜像，解决GitHub更新下载缓慢的问题，并增加安装包防篡改校验与新手使用引导。"
        })
      ])
    }),
    "2.0.0": Object.freeze({
      title: "LitMTrans 2.0.0",
      entries: Object.freeze([
        "新增流式阅读与保留页面结构的排版阅读。",
        "支持MinerU文献结构化解析、全文翻译、文献问答，以及要点提炼、思维导图和研究流程图。",
        "内置DeepSeek官方网页模式，也支持自行配置其他AI服务的API模式。",
        "新增首次使用指南，并在工作台内说明MinerU令牌、网页模式和API模式的配置方式。",
        "版本说明内置在安装包中，升级后即使没有网络也可以查看本次更新内容。"
      ])
    })
  });
})(this);
