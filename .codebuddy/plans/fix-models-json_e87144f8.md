---
name: fix-models-json
overview: 修复 ~/.codebuddy/models.json 中第二个模型缺少逗号的 JSON 语法错误，使自定义模型能正常显示
todos:
  - id: fix-json-comma
    content: 修复 ~/.codebuddy/models.json 第23行 apiKey 值后缺少的逗号
    status: completed
---

修复 ~/.codebuddy/models.json 文件中的 JSON 语法错误：第 23 行 apiKey 值末尾缺少逗号，导致整个配置文件无法解析，自定义模型在 CodeBuddy 下拉列表中不显示。

仅修复 JSON 语法，无需技术选型。