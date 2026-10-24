# Kick & YouTube Overlay for Twitch (with new AdBlock Approach)

**Idioma:** Português | [English](README.en.md)

Use o player da Kick ou do YouTube diretamente na Twitch, com bloqueio de anúncios.

## Recursos

- Reproduz streams da Kick e do YouTube sobre o player da Twitch.
- Bloqueia anúncios em lives e VODs da Twitch.
- Restaura mudo e volume depois dos anúncios.
- Permite configurar um player diferente para cada canal da Twitch.
- Usa a Kick quando o YouTube não está disponível, e volta para a Twitch quando nenhum dos dois está.
- Mantém o chat e o resto da página da Twitch funcionando.
- Não pede login, não tem analytics e não envia telemetria.

O bloqueio de anúncios é experimental e pode não funcionar em todas as situações.

## Como o bloqueio de anúncios funciona

O Twitch às vezes coloca o anúncio dentro da própria live. A extensão tenta lidar com isso de duas formas:

1. Antes do anúncio carregar, tenta impedir que ele entre na transmissão.
2. Se o anúncio já estiver na transmissão, troca para uma versão limpa da live que já foi preparada em segundo plano. Essa versão fica escondida e muda até ser necessária.

Quando o intervalo termina, a extensão volta para o player normal da Twitch e restaura o mudo e o volume.

Se a versão limpa não estiver pronta, a extensão deixa o player normal no lugar em vez de mostrar uma tela preta. Ela não recarrega a página automaticamente.

## Instalação

1. Baixe o repositório em **Code** → **Download ZIP**.
2. Extraia o ZIP.
3. Abra `chrome://extensions` no Chrome ou em outro navegador Chromium.
4. Ative o **Modo do desenvolvedor**.
5. Clique em **Carregar sem compactação** e escolha a pasta `kick-overlay`.
6. Abra a Twitch e recarregue a página.

A extensão não está publicada na Chrome Web Store. A pasta `kick-overlay` precisa continuar no computador.

## Uso

1. Abra um canal na Twitch e clique no ícone da extensão.
2. Escolha o player:
   - **Twitch:** usa o player nativo.
   - **Kick:** informe o canal da Kick, ou deixe em branco para usar o mesmo nome do canal da Twitch.
   - **YouTube:** informe a URL da live, o `@handle` ou o ID do canal.
3. Clique em **Save**. A configuração fica salva por canal da Twitch.
4. Use o popup para ligar ou desligar o overlay e o bloqueio de anúncios.

A barra do player indica a fonte: verde para Kick, vermelha para YouTube. Sem barra do projeto, o player é o nativo da Twitch.

## Problemas comuns

- **Atualizei a extensão e o comportamento antigo continua:** recarregue a aba da Twitch.
- **Sem áudio depois do anúncio:** recarregue a página e confira se o overlay está ligado.
- **Tela preta ou player travado:** desligue o overlay e recarregue a página.
- **Kick ou YouTube não aparece:** confira se o canal está ao vivo e se o nome ou a URL está correto.
- **Anúncio apareceu:** o bloqueio é experimental; confira se a opção **Twitch adblock** está ligada.

## Privacidade

As configurações e os logs ficam no seu navegador. A extensão não coleta analytics e não envia dados para um servidor do projeto.

## Desenvolvimento

Verificação rápida:

```powershell
node _tools/ko-verify.mjs
```

Notas técnicas:

- `kick-overlay/ADBLOCK-FINDINGS.md`
- `kick-overlay/PLAYER-1TO1-RESEARCH.md`
- `TODO.md`

## Limitações

- O bloqueio pode falhar quando a Twitch muda a forma de entrega.
- Em alguns casos, o anúncio de abertura pode aparecer mudo por alguns instantes.
- O overlay não é um clone 1:1 da Kick ou do YouTube. Use **Abrir no site oficial** no popup para a interface completa.
- A extensão não é afiliada à Twitch, Kick ou YouTube.

Feito por [@mateusant13](https://github.com/mateusant13).
