# 资料批注阅览器

`/portal` 是业务阅览页面，文档与批注分别延迟加载。当前文档身份 device-manual，version=manual-N。段落 id 在同一版本中稳定，section 表示章节，不等于唯一文本锚点。定位按钮以用户正常操作建立 DOM Selection；没有选区时不能伪造文本偏移。

相同 quote 可以出现在目录、正文和同章节不同段落；mode=ambiguous 增加一个合法候选。线程有 open、resolved、deleted，未加载的分页不能证明线程删除。切换文档版本会清除选区，改变正文并给一个旧线程删除状态，旧 quote 在新正文可能不再成立。

批注输入来自现有页面，不创建新批注。采集记录需要包含引用的文档版本、章节/段落身份以及来源中可验证的文本范围或歧义，不用屏幕像素坐标代替文本关系。页面缩窄会重排但不改变文档版本。

## 批注采集约定

`src/annotations.mjs` 通过真实浏览器驱动 `/portal`，在页面内建立文本选区并回收来源响应，产出可复核的批注—正文关系，不做摘要或解释：

- 每条线程记录 `author`、`comment`、`status`（open/resolved/deleted），并用来源响应与页面 DOM 双向核对（`statusVerified`）。
- 锚点 `anchor.state` 分三种：`located`（章节与引用文本唯一命中，附段落 id、文本偏移 `textOffset`、真实选区文本与 `verified` 校验）、`ambiguous`（同章节多个段落命中，列出全部 `candidates`，不任选第一处）、`no-match`（当前正文已无匹配，记录空候选）。目录段落章节不同，不计入候选。
- 锚点只含文档版本、章节/段落身份与文本偏移，不记录屏幕坐标；每次定位前清空选区并重新点击页面按钮、重新读取当前 DOM。
- 分页未加载的线程不会出现在结果里，由 `content.moreThreadsAvailable` 标明尚有后续；它与来源明确返回的 `status: deleted` 严格区分。
- 切换版本或折叠/展开段落会清空上一遍采集与选区，再按新正文从零重建锚点；旧引用在新正文不成立时记 `no-match`，删除是线程状态，与锚点关系分别记录。
- 采集到的 `/document`、`/segments`、`/threads` 原始响应作为内容对象入 `Archive`，采集结果（`collections/`）只通过凭据 id 与摘要引用，保证每条关系可回到来源字节复核。

## 本地演练控制

`GET /_health` 返回服务健康状态；`GET /_audit` 仅返回请求路径、方法和体积，不记录凭据。`POST /_control` 接收 JSON，可调整 generation、mode、clock。控制端点只服务于本地演练，不是资料接口，也不是浏览器业务操作入口。每次重新启动服务都会恢复初始数据；生产接入时不部署此控制面。
