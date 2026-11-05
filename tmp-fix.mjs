const fs = require('fs');
let s = fs.readFileSync('README.md', 'utf8');
const anchor = '## 已验证 / 未验证';
const line = '- ⚠️ **③ 通配兜底的谓词 matcher**：文档「深匹配」节声明支持函数谓词、每次事件重评；离线单测钉死互斥逻辑，宿主实际路由需 /login 后用一个 MCP 工具大输出看是否带标记。\n';
if (s.includes('通配兜底的谓词')) console.log('dup');
else { s = s.replace(anchor, line + anchor); fs.writeFileSync('README.md', s); console.log('inserted'); }
