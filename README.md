# Compra Casa BH

Ferramenta de apoio à decisão de compra de imóvel em Belo Horizonte. Ela lê dados geográficos abertos da Prefeitura (BHMap) em GeoJSON e colore a cidade inteira com uma nota de 0 a 100, em células de 100 m, para mostrar as **áreas de interesse** segundo critérios que você pondera:

- **Tempo de ônibus até os seus destinos** (trabalho, escola, família), com até uma baldeação.
- **Ônibus perto de casa**: quantas linhas diferentes param a uma caminhada do imóvel.
- **Distância de vilas e favelas**.
- **Critérios extras de distância**, declarados em `criterios.json` (já vêm EMEIs e escolas municipais de ensino fundamental).

## Como usar

Abra `index.html` no navegador (ou a versão publicada no GitHub Pages deste repositório). Não precisa instalar nada; é necessário internet para o mapa de fundo e para a busca de endereço.

1. Clique no mapa, ou busque um endereço, e escolha **Usar como destino**. Pode ter vários.
2. Ajuste pesos e limites de cada critério no painel. O mapa recalcula na hora.
3. Clique no endereço de um imóvel e escolha **Salvar como imóvel** para comparar candidatos lado a lado e ver a rota de ônibus de cada um.

Destinos, imóveis e pesos ficam salvos só no seu navegador.

## Adicionar um critério novo

Critérios de distância (centros de saúde, parques, estações, o que houver em GeoJSON) não exigem programação:

1. Coloque o arquivo GeoJSON na pasta do projeto. Pode ter pontos, linhas ou polígonos, em EPSG:31983 (padrão do BHMap) ou latitude/longitude.
2. Acrescente um item em `criterios.json`:

   ```json
   {
     "id": "saude",
     "nome": "Centro de saúde por perto",
     "rotulo": "Centro de saúde",
     "arquivo": "CENTRO_SAUDE.json",
     "campoNome": "NOME",
     "melhor": "perto",
     "otimo": 500,
     "limite": 2000,
     "peso": 2,
     "cor": "#d32f2f"
   }
   ```

3. Rode `node preparar_dados.js` e recarregue a página. O critério ganha um cartão próprio com peso, limites e a opção de mostrar ou ocultar no mapa.

| Campo | Significado |
|---|---|
| `id` | Identificador único (letras, números e `_`). |
| `nome`, `rotulo` | Título do cartão e nome curto usado nos detalhes. |
| `arquivo` | GeoJSON na pasta do projeto. |
| `campoNome` | Propriedade com o nome de cada item (padrão `NOME`). |
| `melhor` | `"perto"` (quanto mais perto, melhor) ou `"longe"` (quanto mais longe, melhor). |
| `otimo` | Distância em metros que recebe nota máxima. |
| `limite` | Distância em metros que recebe nota zero. |
| `peso` | De 0 a 10. Com 0, aparece no mapa mas não entra na nota. |
| `cor` | Cor no mapa. |
| `eliminar` | Opcional. `true` descarta as áreas além do limite. |
| `mostrar` | Opcional. `false` faz o critério começar oculto no mapa. |

Ocultar um critério no mapa é só visual: ele continua valendo na nota. Para tirá-lo da conta, ponha o peso em 0.

Os pesos de `criterios.json` são o padrão inicial. Quem já mexeu nos controles mantém os próprios valores; o botão **Restaurar pesos e premissas padrão** volta ao que está no arquivo.

## Atualizar os dados

Os arquivos vêm do [BHMap](https://bhmap.pbh.gov.br/) (Prefeitura de Belo Horizonte), exportados em GeoJSON:

| Arquivo | Conteúdo |
|---|---|
| `ITINERARIO_TRANSPORTE_COLETIVO.json` | Traçado das linhas de ônibus |
| `PONTO_ONIBUS.json` | Pontos de ônibus por linha |
| `SETOR_CENSITARIO_2022.json` | Setores censitários (limite do município, bairros, população) |
| `VILA_FAVELA.json` | Vilas, favelas e loteamentos públicos de interesse social |
| `ESCOLAS_MUNICIPAIS_*.json` | Escolas municipais (critérios extras) |

Baixe as versões novas com os mesmos nomes, substitua na pasta e rode (requer [Node.js](https://nodejs.org/), sem dependências):

```bash
node preparar_dados.js
```

O script gera `dados.js`, que é o único arquivo de dados que a página carrega.

## Como a nota é calculada

A nota de cada célula é a média ponderada das notas de cada critério (0 a 1), multiplicada por 100.

- **Tempo de ônibus**: caminhada até o ponto + espera + trecho no ônibus (distância ao longo do itinerário ÷ velocidade) + caminhada final. A caminhada usa 4,5 km/h e a distância em linha reta × 1,3.
- **Linhas por perto**: linhas distintas com ponto dentro da caminhada máxima.
- **Distâncias** (vilas e critérios extras): linha reta até o item mais próximo.

## Limitações

- **O tempo de ônibus é uma estimativa.** Os dados não trazem horários nem frequência; velocidade e espera são premissas ajustáveis, iguais para todas as linhas.
- Sublinhas de carnaval, madrugada, desvios e eventos ficam fora do cálculo.
- Metrô e ônibus metropolitanos não estão nos dados.
- Algumas linhas têm pontos mas não têm itinerário no arquivo; elas contam como "linha por perto", mas não entram no tempo de viagem.
- Só há escolas da rede municipal.
- A ferramenta ajuda a comparar regiões; não substitui visitar o imóvel e o bairro.

## Créditos

Dados: Prefeitura de Belo Horizonte (BHMap) e IBGE (Censo 2022). Mapa de fundo e busca de endereço: © colaboradores do OpenStreetMap. Mapa interativo: Leaflet.
