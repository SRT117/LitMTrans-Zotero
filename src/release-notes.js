(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};

  // 发布新版本时，在 ReleaseNotes 中增加或修改对应版本的条目。
  LitMTrans.StartupContent = Object.freeze({
    welcome: Object.freeze({
      title: "欢迎使用LitMTrans",
      paragraphs: Object.freeze([
        "LitMTrans是一个免费的开源项目。项目本身免费；日常使用网页模式时，翻译和问答目前也免费。",
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
        "新增 AI 助手连接，可协助搜索和整理 Zotero 文献、查找并导入可获取的论文，以及整理文献证据和综述资料。",
        "新增 DeepSeek 官方网页模式，登录后即可翻译和问答，无需配置 API 密钥。",
        "扩展对 CAJ、KDH、HN、C8 等知网文献格式的阅读与转换支持。",
        "优化长文献翻译、图片处理和 PDF 导出体验，修复公式显示、英文重译和手动翻译粘贴等问题。",
        "新增插件数据管理，可查看和清理缓存；改进更新下载流程，并增加首次使用引导。"
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
