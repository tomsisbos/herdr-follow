VSCE := npx --yes @vscode/vsce@3.9.2
VERSION := $(shell node -p "require('./package.json').version")
VSIX := herdr-follow-$(VERSION).vsix

.PHONY: smoke package install uninstall workspace clean

smoke:
	node scripts/smoke.js

package: $(VSIX)

$(VSIX): extension.js package.json README.md LICENSE
	$(VSCE) package --no-dependencies --allow-missing-repository -o $@

install: $(VSIX)
	code --install-extension $(VSIX) --force

uninstall:
	code --uninstall-extension local.herdr-follow

clean:
	rm -f *.vsix

# Anchor workspace next to the worktrees; relative paths resolve against the file.
# Folder #1 stays fixed because VS Code restarts extensions when the first folder changes.
WORKSPACE := $(HOME)/.herdr/herdr.code-workspace

workspace:
	@test ! -e $(WORKSPACE) || { echo "$(WORKSPACE) already exists"; exit 1; }
	printf '{\n  "folders": [{ "path": "worktrees" }],\n  "settings": { "herdrFollow.enabled": true }\n}\n' > $(WORKSPACE)
	@echo "Open it with: code $(WORKSPACE)"
