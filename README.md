# Kick & YouTube Overlay for Twitch

Assista **Kick** e **YouTube** dentro do player da Twitch - e deixe os anúncios da Twitch fora do caminho.

A extensão mantém o player nativo da Twitch quando você está na Twitch. O overlay de Kick/YouTube só entra quando você escolhe esses players no popup. O adblock da Twitch funciona em cima do player nativo, sem trocar de site.

---

## O overlay em 30 segundos

O overlay é uma **segunda camada de vídeo** que fica por cima do player da Twitch. O player da Twitch continua rodando embaixo, mudo, e o chat, os controles, as raids e o resto da página continuam funcionando.

Quando você escolhe **Kick** ou **YouTube** no popup, a extensão troca apenas o vídeo que aparece. Não abre outra aba, não muda de site e não substitui a Twitch.

---

## O que você ganha

- **Overlay de Kick** - o canal da Kick toca por cima do player da Twitch, com os controles do projeto.
- **Overlay de YouTube** - funciona com URL de live/vídeo, `@handle` ou ID `UC...`. Se o YouTube não estiver disponível, a extensão tenta a Kick antes de voltar para a Twitch.
- **Adblock para lives da Twitch** - reescreve o token do player, remove os blocos de anúncio dos playlists e, quando o anúncio já veio colado no stream, cobre o player com um frame limpo em 360p até o intervalo acabar.
- **Adblock para VODs da Twitch** - bloqueia as requisições de anúncio CSAI dos vídeos sob demanda.
- **Adblock sem trocar o player** - fora de um anúncio, o adblock não mexe no player. A troca só acontece quando você escolhe Kick/YouTube ou quando o fallback é necessário.
- **Áudio de volta sozinho** - o estado de mudo e o volume são salvos antes do anúncio e restaurados depois. Você não precisa clicar no ícone de volume.
- **Sem rewind e sem áudio duplicado** - o standby fica escondido e mudo; o player nativo é silenciado enquanto o frame limpo está na frente.

---

## Como instalar e usar (passo a passo)

### 1. Baixe o ZIP

No GitHub, clique no botão verde **Code** (ou **Código**) → **Download ZIP**.

### 2. Extraia o ZIP

Abra o `.zip` e arraste a pasta de dentro para a **Área de Trabalho** (ou outro lugar que você não vá apagar).

A pasta da extensão é a **`kick-overlay`** - a que tem o arquivo `manifest.json` dentro. Não é a pasta raiz do projeto.

### 3. Abra a página de extensões do navegador

| Navegador | Endereço |
|-----------|----------|
| Google Chrome | `chrome://extensions` |
| Brave | `brave://extensions` |
| Microsoft Edge | `edge://extensions` |
| Opera | `opera://extensions` |
| Vivaldi | `vivaldi://extensions` |
| Arc (Chromium) | `chrome://extensions` |

### 4. Ative o modo desenvolvedor

No canto superior direito, ligue **Modo do desenvolvedor** (Developer mode).

### 5. Carregue a extensão

- **Opção A:** arraste a pasta **`kick-overlay`** para dentro da página de extensões, **ou**
- **Opção B:** clique em **Carregar sem compactação** (Load unpacked) e escolha a pasta **`kick-overlay`**.

### 6. Fixe o ícone e abra a Twitch

Clique no ícone da extensão na barra do navegador e deixe-o fixado. Depois abra a Twitch e **recarregue a aba uma vez** (F5) para o content script entrar.

> **Importante:** a pasta `kick-overlay` precisa continuar no computador. O navegador lê os arquivos dela direto; não apague enquanto estiver usando.

---

## Como trocar para Kick ou YouTube

1. Abra o canal na Twitch.
2. Clique no ícone da extensão.
3. Escolha o player:

   | Player | O que faz |
   |--------|-----------|
   | **Kick** | Usa o canal da Kick que você informar. Se deixar em branco, tenta o mesmo nome da Twitch. |
   | **YouTube** | Cole a URL da live/vídeo, o `@handle` ou o ID `UC...`. Se o streamer usa outro nome no YouTube, é aqui que você ajusta. |
   | **Twitch** | Mantém o player nativo; o adblock continua ativo. |

4. Preencha o canal e clique em **Save**. O ajuste vale só para aquele canal da Twitch.
5. Use o toggle **Overlay** para ligar/desligar o player alternativo.
6. Use o toggle **Twitch adblock** para ligar/desligar o bloqueio de anúncios.

### Streamer com o mesmo nome em outra plataforma

Se o streamer usa o mesmo nome na Kick, você não precisa configurar nada: escolha **Kick** e a extensão procura esse nome. Se a Kick estiver ao vivo, o player muda para a Kick. Se não estiver, a extensão não inventa outro canal: volta para o player nativo da Twitch.

No YouTube o nome não basta. Preencha a URL, o `@handle` ou o ID `UC...` no popup. Se você escolher **YouTube** e a extensão não encontrar o canal/vídeo, ou ele não estiver ao vivo, ela tenta a Kick: usa o canal da Kick configurado; se não houver, tenta o mesmo nome da Twitch. Se a Kick também não estiver ao vivo, fica na Twitch.

A preferência salva continua sendo YouTube. O desvio para a Kick vale só para aquela sessão; ao recarregar a página, a extensão tenta o YouTube de novo.

### A barra diz qual player está na frente

| Cor da barra | Player |
|--------------|--------|
| Verde | Kick, incluindo o fallback automático |
| Vermelha | YouTube |
| Sem barra do projeto | Twitch nativo |

Se você escolheu YouTube e a barra ficou verde, o YouTube não foi encontrado ou estava fora do ar, e a extensão caiu para a Kick. Confira a URL, o `@handle` ou o ID e se a live está no ar.

### Atualizei a extensão e nada mudou

O content script só é trocado quando a página recarrega. Dê **F5** na aba da Twitch depois de atualizar a extensão.

---

## Anúncio no meio da live: o que acontece

O Twitch coloca os anúncios de live **dentro do próprio playlist** (SSAI). Não é um banner que dá para bloquear por CSS; o anúncio chega costurado no stream.

A extensão faz três coisas, nesta ordem:

1. **Reescreve o token** e remove as linhas de anúncio dos playlists.
2. Se o anúncio já estiver colado, **cobre o player** com um player limpo que já estava pronto e mudo (standby).
3. Quando o intervalo termina, **devolve o player nativo** na qualidade original e restaura mudo + volume.

### Por que o frame limpo fica em 360p

Durante o intervalo, o frame limpo é **360p**. Fora do anúncio, o player nativo volta para a qualidade que você escolheu (até 1080p).

Isso é de propósito: em intervalos longos, a fonte em HD pode virar “só anúncio”. Foi isso que já causou tela preta e travamento. Por isso, durante o intervalo, o frame limpo fica em 360p - e o player nativo volta à sua qualidade quando o intervalo termina.

### Abriu a live e o anúncio veio junto: e agora?

A página **não recarrega sozinha**. A extensão não usa F5 automático nem “refresh infinito”: isso foi medido e descartado, porque o anúncio volta junto com o novo carregamento.

O que acontece:

1. Assim que a live abre, a extensão começa a preparar um player limpo escondido (o standby). Ela não espera o primeiro playlist nem a verificação completa: o standby começa assim que o endereço limpo é criado.
2. Se o anúncio chegar no mesmo instante em que a página ainda está carregando, o anúncio nativo pode aparecer **mudo** por instantes.
3. Quando o standby fica saudável, ele cobre o anúncio. Em geral isso leva menos de 1 segundo depois que o anúncio começa, mas depende da rede.
4. Se o standby não ficar saudável, a extensão mantém ou devolve o player nativo em vez de deixar uma tela preta.

Ou seja: o “buffer” já acontece em paralelo, num player separado. Não precisa dar F5. Recarregar a página só reinicia a espera e pode trazer o anúncio de novo. Se o anúncio aparecer no meio da live, o processo é o mesmo.

---

## Deu problema? Veja aqui

| Problema | O que fazer |
|----------|-------------|
| Atualizei a extensão e o comportamento antigo continua | Recarregue a aba da Twitch com **F5**. O content script só troca no próximo carregamento. |
| Fiquei sem áudio depois do anúncio | Confirme que está na **0.8.29** ou mais novo e dê **F5**. A versão 0.8.29 restaura volume + mudo; antes disso o volume ficava em 0. |
| Apareceu um anúncio | No anúncio antes da live, ele ainda pode aparecer **mudo** por instantes se chegar junto com o carregamento. A extensão começa o standby mais cedo e cobre assim que ele fica saudável; isso é preferível a uma tela preta. Se acontecer no meio de um intervalo longo, verifique se o toggle **Twitch adblock** está ligado. |
| Tela preta ou player travado | A extensão tenta voltar para o player nativo quando o frame limpo não chega a `Playing`. Se persistir, dê **F5** e desligue o overlay para isolar o problema. |
| Kick ou YouTube não aparece | Confira se o canal está ao vivo e se o nome/URL está certo. Se o streamer faz multi stream, confirme no popup se o canal da Kick/YouTube é o mesmo que ele está usando. O mapeamento é por canal e fica salvo. |
| Escolhi YouTube, mas apareceu o player da Kick | O YouTube não foi encontrado ou não estava ao vivo, então a extensão usou o fallback para a Kick. Confira a URL, o `@handle` ou o ID. A barra fica verde no Kick e vermelha no YouTube. |
| Quero o player 1:1 da Kick ou do YouTube | Não existe um clone 1:1 confiável e mantido. O player oficial só roda no site do provedor: o da Kick não deixa a extensão controlar mute e pause, e o do YouTube pode cair em bloqueio sem cookie e mostrar anúncios. O projeto usa o mesmo motor da Kick e HLS do YouTube com a barra do overlay. Para a experiência 1:1, use **Abrir no site oficial** no popup. |
| Apareceu um player diferente sem anúncio | O frame limpo do anúncio só entra quando a extensão detecta um anúncio. Se não havia anúncio, veja a cor da barra: verde é o fallback da Kick, vermelha é o YouTube. |
| Quero conferir a versão | Abra `chrome://extensions` e veja o número embaixo do nome. |

---

## Seus dados ficam com você

- **Não pede senha** da Twitch, Kick ou YouTube. Usa a sessão que você já tem aberta no navegador.
- Configurações, mapeamentos e o log de anúncios ficam **só no seu navegador** (`chrome.storage.local`).
- Não há analytics, telemetria ou servidor do projeto. As únicas conexões são com as plataformas (Twitch/Kick/YouTube).

---

## Para quem mexe no código

### O que tem em cada pasta

| Caminho | O que é |
|---------|---------|
| `kick-overlay/` | A extensão Chrome (manifest, content scripts, player HLS, popup). |
| `_tools/` | Harness de teste via CDP (Chrome/Edge separado). |
| `kick-overlay/ADBLOCK-FINDINGS.md` | Log técnico do adblock: o que foi medido, o que falhou e por quê. **Leia antes de mexer no `twitch-adblock.js`.** |
| `TODO.md` | Estado final do projeto e limitações aceitas. |

### Como testar sem atrapalhar seu Chrome

```powershell
node _tools/ko-harness.mjs check --fresh --yt='https://www.youtube.com/watch?v=3cOk_W3ewcE'
```

O harness sobe um perfil separado (porta 9335) para não mexer no seu Chrome. O relatório vai para `G:\Temp\opencode\ko-harness-report.json`.

Para um portão rápido, sem abrir navegador: `node _tools/ko-verify.mjs`. Ele checa sintaxe, manifesto, contrato do cold open e o ledger de bugs, executa os braços negativos e escreve um recibo em `_evidence/`.

### As regras do adblock

- Nunca revelar um frame sem `Playing` saudável (`readyState >= 3`); se travar, voltar ao nativo.
- O standby fica sempre mudo e escondido; clique na página não pode desmutá-lo.
- Salvar e restaurar `muted` **e** `volume`: o Twitch zera o volume quando o elemento é mutado.
- Sem rewind no caminho quente; o standby já está tocando.
- Durante o anúncio, o frame limpo é 360p; fora dele, o player nativo volta à qualidade escolhida.

---

## O que ele ainda não resolve

- **Anúncio de live:** durante o intervalo, o frame limpo é 360p. Fora do anúncio, o player nativo volta à qualidade escolhida.
- **Anúncio antes da live:** se o anúncio chegar junto com o carregamento, ele ainda pode aparecer mudo por instantes. A extensão começa o standby mais cedo e cobre assim que ele fica saudável; a alternativa seria uma tela preta, que foi descartada.
- **Player 1:1:** o overlay chega perto, mas não é um clone exato da Kick ou do YouTube. O player oficial não pode ser controlado pela extensão (e o do YouTube pode bloquear sem cookie), então o caminho para 1:1 real é o atalho **Abrir no site oficial** no popup. A pesquisa está em `kick-overlay/PLAYER-1TO1-RESEARCH.md`.
- **Twitch muda com frequência:** se o Twitch mudar o formato do SSAI, o adblock pode parar de funcionar até uma atualização. O log em `ADBLOCK-FINDINGS.md` existe para facilitar o diagnóstico.
- **VOD:** o bloqueio é de CSAI; se o Twitch mudar a entrega, pode ser necessário ajustar os hosts bloqueados.
- **A extensão não é afiliada** à Twitch, Kick ou YouTube.

---

Feito por [@mateusant13](https://github.com/mateusant13).
