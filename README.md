# lsp-plugins

Marketplace de plugins LSP locaux pour **Claude Code**, **Codex** et **GitHub Copilot CLI**.

Le plugin [local-lsp](plugins/local-lsp/README.md) fournit la navigation sémantique et les diagnostics pour C#, Terraform, TypeScript/JavaScript, Python, YAML, Dart/Flutter et PHP. Claude Code et Copilot CLI utilisent leur intégration LSP native ; Codex utilise le pont MCP local `lspi`.

## Prérequis

- Installer les serveurs de langage nécessaires et rendre leurs commandes accessibles dans le `PATH` du client.
- Pour Codex, disposer de Node.js 20 ou supérieur et de `lspi` 0.2.0, installé séparément.

Les commandes, les limites de prise en charge et les vérifications disponibles sont détaillées dans le [README du plugin](plugins/local-lsp/README.md).

## Installation locale

Cloner le dépôt, puis exécuter les commandes correspondant au client depuis la racine du dépôt.

### Claude Code

```powershell
claude plugin marketplace add .
claude plugin install local-lsp@local-lsp
```

### GitHub Copilot CLI

```powershell
copilot plugin marketplace add .
copilot plugin install local-lsp@local-lsp
```

### Codex

```powershell
cd plugins/local-lsp
npm link --ignore-scripts
cd ../..
codex plugin marketplace add .
codex plugin add local-lsp@local-lsp
local-lsp-mcp --doctor
```

Conserver le dépôt en place après `npm link`. Redémarrer le client après installation et lancer Codex depuis le projet à analyser.

## Diagnostic et développement

Le skill [lsp-doctor](plugins/local-lsp/skills/lsp-doctor/SKILL.md) vérifie les serveurs pertinents, leur configuration et leur fonctionnement dans le projet courant.

La configuration source est [lsp-config/claude.json](plugins/local-lsp/lsp-config/claude.json). Après modification, synchroniser la configuration Copilot et lancer les tests :

```powershell
cd plugins/local-lsp
npm run sync
npm test
```

Pour vérifier la navigation sémantique réelle, exécuter `node scripts/verify-semantic.mjs` depuis le dossier du plugin. Cette vérification nécessite les six serveurs installés et le SDK .NET 10.

Le code de ce dépôt est distribué sous [licence MIT](LICENSE). Les serveurs de langage et le pont `lspi`, installés séparément, conservent leurs propres licences.
