CD into vscode
```bash
export VSCODEVERSION=$(code --version | head -1)
mkdir -p "./vscode-server/${VSCODEVERSION}"
cd "./vscode-server/${VSCODEVERSION}"
```

Get commit hash from vscode
```bash
export VSCODESERVER=$(code --version | head -2 | tail -1)
```

Download latest server for alpine linux **x64**
```bash
wget -O vscode-server-alpine-x64.tar.gz "https://update.code.visualstudio.com/commit:${VSCODESERVER}/server-linux-alpine/stable"
```

Download latest server for debian **x64**
```bash
wget -O vscode-server-debian-x64.tar.gz "https://update.code.visualstudio.com/commit:${VSCODESERVER}/server-linux-x64/stable"
```

Download latest client for debian **x64**
```bash
wget -O https://vscode.download.prss.microsoft.com/dbazure/download/stable/${VSCODESERVER}/vscode_cli_alpine_x64_cli.tar.gz
```

Download extensions by Id using
```bash
https://cypherpunksamurai.github.io/vsix-downloader-webui/
```