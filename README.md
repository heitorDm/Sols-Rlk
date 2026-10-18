# Sol's RNG — Dark Fantasy (servidor)

Este pacote mantém o jogo original e muda a camada de conta/coop: agora o cadastro e o login são feitos diretamente no servidor, o progresso fica ligado à conta, e os amigos entram na mesma sala por código ou link de convite. O projeto não exige URL/chave do Supabase.

## Iniciar no Windows

1. Instale o **Python 3.11 ou mais recente** se ainda não estiver instalado.
2. Extraia a pasta inteira do ZIP para um local normal do computador.
3. Dê dois cliques em `run_windows.bat`.
4. Na primeira execução, o arquivo instala as dependências automaticamente. Quando o navegador abrir, acesse `http://127.0.0.1:5000`.
5. Deixe a janela preta do servidor aberta enquanto joga. Ela não é um erro: é o servidor funcionando.

No jogo, abra **CONTA & COOP ONLINE**. Crie uma conta com nome no jogo, e-mail e senha de pelo menos 8 caracteres. Depois de iniciar/carregar uma run, use **CRIAR SALA + CONVITE** e envie o link copiado ao seu amigo. Cada jogador precisa ter sua própria conta.

## Jogar na mesma rede Wi-Fi

No computador que executa o servidor, descubra o endereço IPv4 da rede local (no Windows, `ipconfig`). Abra também `http://IP-DO-COMPUTADOR:5000` no computador anfitrião, entre na mesma conta e crie a sala por esse endereço — assim o link copiado aponta para o IP certo. Os outros jogadores abrem o link ou acessam `http://IP-DO-COMPUTADOR:5000` (por exemplo `http://192.168.1.25:5000`) e digitam o código da sala. Permita o Python na rede privada do Firewall do Windows, caso ele pergunte.

## Jogar com amigos pela internet

É necessário publicar **esta pasta inteira** em um servidor acessível pela internet. Não basta hospedar apenas o HTML, porque login, saves e salas dependem do Python e do Socket.IO. O `Dockerfile` está incluído para provedores que aceitam implantação por Docker.

Configure estas variáveis no servidor online:

- `SECRET_KEY`: um segredo aleatório longo e privado.
- `COOKIE_SECURE=1`: use em sites HTTPS.
- `DATABASE_PATH`: caminho para um banco SQLite em armazenamento persistente, por exemplo `/var/data/solsrng.sqlite3`.
- `PORT`: normalmente definido automaticamente pelo provedor.

**Importante:** o SQLite precisa ficar em disco persistente na hospedagem; não coloque senhas ou chaves secretas no HTML. Em uma hospedagem com sistema de arquivos temporário, contas e saves podem ser apagados quando o serviço reiniciar. Para o coop, mantenha uma única instância do servidor, pois a lista de salas fica na memória desse processo.

## Dados guardados

- `data/solsrng.sqlite3`: usuários, hashes das senhas e saves por conta.
- `static/game.html`: o jogo completo entregue pelo usuário com o cliente do servidor integrado.
- `static/server_bridge.js`: a camada de conta, save na nuvem e coop; fica separada para facilitar manutenção.
- `game_original_backup.html`: cópia intacta do HTML que foi enviado originalmente.

As senhas nunca são guardadas em texto puro; o servidor armazena hashes. O progresso local existente é importado para a conta ao criar uma conta neste navegador.

## Resolução de problemas

- Se `python` não for reconhecido, instale Python e marque a opção para adicioná-lo ao PATH; depois execute `run_windows.bat` novamente.
- Se a página não abrir, confirme que a janela do servidor continua aberta e tente `http://127.0.0.1:5000`.
- Se o firewall bloquear conexões na rede Wi-Fi, autorize o Python na rede privada.
- Para verificar se o servidor está respondendo, abra `http://127.0.0.1:5000/healthz`; deve aparecer `status: ok`.
