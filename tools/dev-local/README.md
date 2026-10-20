# dev-local

维护这台开发机自身环境的一次性脚本。**与插件功能无关**，也不属于 npm 包内容。

放在这里是为了让 `tools/` 保持干净——只留下别人跑测试、装插件时真正需要的东西。

## repair-links.ps1 / repair_profile_links.py

修 `~/.dsh/profiles/node_modules` 下约 550 个失效 junction。

**症状**：插件能挂载，但导入时 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-llm`。

**原因**：这些 junction 指向旧的 Electron 安装目录（`E:\dsh\DSH Desktop\...`）。DSH 重装或移动后旧路径消失，Node 的模块解析沿路上找到断链就停止，不再继续向上查找，于是插件拿不到 harness 提供的 peer。

**用法**：

```sh
python tools/dev-local/repair_profile_links.py --dry-run   # 先看会改多少
python tools/dev-local/repair_profile_links.py --apply
```

或用批量版（一次 PowerShell 进程改完，快得多）：

```powershell
pwsh -NoProfile -File tools/dev-local/repair-links.ps1 -Apply
```

**注意**：只有目标在**当前**安装里存在的链接才能修（`--dry-run` 会分别报「可修」和「确实缺失」）。Windows 上 junction 是 reparse point，`os.remove` 删不掉，必须用 `cmd /c rmdir` 或 PowerShell `Remove-Item`。

**你不会需要这些脚本**，除非你也在 Windows 上把 DSH 换过安装位置。
