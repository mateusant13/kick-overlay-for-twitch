# Kick & YouTube Overlay for Twitch (with new AdBlock Approach)

**Idioma:** Português | [English](README.en.md)

A extensão coloca o vídeo da Kick ou do YouTube sobre o player da Twitch. Ela também bloqueia anúncios da Twitch.

## Recursos

- Reproduz a live atual da Twitch pela Kick ou pelo YouTube; a escolha fica salva por canal.
- Bloqueia anúncios em lives e VODs da Twitch.
- Usa a Kick quando o YouTube não está disponível, e volta para a Twitch quando nenhum dos dois está.

O bloqueio de anúncios é experimental e pode não funcionar em todas as situações.

## Como o bloqueio de anúncios funciona

O Twitch insere anúncios dentro da própria live. A extensão tenta bloquear o anúncio antes de ele carregar. Se o anúncio já estiver na transmissão, ela troca para uma versão sem anúncio preparada em segundo plano.

Essa versão fica escondida e muda até ser necessária. Quando o intervalo termina, a extensão volta ao player normal da Twitch.

Com a versão pronta, a troca é imediata. Se ela ainda não estiver pronta e o player já estiver tocando, a extensão volta alguns segundos no player da Twitch para o trecho já carregado cobrir a troca. Se a versão sem anúncio falhar, o player normal continua no lugar, sem tela preta. A página não recarrega sozinha.

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
