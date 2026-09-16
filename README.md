# aicalc-q – kalkulator kosztów AI (Quantica Lab)

Jednoplikowy kalkulator porównujący miesięczny koszt asystenta RAG w czterech
wariantach:

1. płatne API modelu,
2. GPU w chmurze,
3. **małe wdrożenie na Dell Pro Max GB10** – pakiet wyceniony na **35 000 PLN**,
4. własny serwer (RTX PRO 6000).

Nad infrastrukturą liczona jest warstwa oprogramowania **Zagłoba RAG**:
przy API i chmurze jako SaaS (domyślnie 5 000 PLN / mies. w obu), przy Dell
GB10 i własnym serwerze jako sprzedaż licencji (150 000 PLN jednorazowo,
amortyzowane przez 36 mies.) z rocznym kontraktem wsparcia (20 000 PLN / rok).
Każda karta pokazuje sumę oraz podział „Oprogramowanie · Infrastruktura”;
na wykresie narastającym licencja płatna jest w miesiącu 0 i nie powtarza się
przy wymianie sprzętu.

Kod pochodzi z projektu `aicalc` (workszop/aicalc); ta wersja ma wygląd strony
quanticalab.ai (system `qweb`: biała strona, granatowy panel hero, róż
Quantica jako jedyny kolor wiodący, Satoshi + Geist Mono, karty bento, pigułki).

To **szacunek kosztu inferencji**, a nie oferta, wycena wdrożenia ani gwarancja
jakości lub przepustowości. Wszystkie kwoty są netto, bez VAT.

## Uruchomienie

Projekt nie ma buildu ani zależności npm. Otwórz
[`index.html`](index.html) bezpośrednio w przeglądarce (`file://`) albo
uruchom opcjonalny serwer:

```bash
cd /home/andrzey/git-claude/aicalc-q
python3 -m http.server 8000
```

Następnie otwórz <http://127.0.0.1:8000/index.html>. Fonty (Satoshi, Geist
Mono) ładują się z CDN; bez sieci strona działa na fontach systemowych.

## Małe wdrożenie: Dell GB10

Czwarta ścieżka liczy się tym samym modelem co własny serwer (amortyzacja
zakupu + prąd + stała obsługa; na wykresie kolejny zakup co okres wymiany).
Domyślne parametry są edytowalne w panelu ustawień:

| Parametr | Domyślnie | Uwaga |
| --- | --- | --- |
| `smallCapex` | 35 000 PLN | cena pakietu Dell GB10 z konfiguracją |
| `smallAmort` / `smallReplace` | 36 mies. | amortyzacja i wymiana rozliczane osobno |
| `smallOps` | 0 PLN / mies. | utrzymanie sprzętu nie jest liczone (wsparcie jest w kontrakcie Zagłoba RAG) |
| `smallPower` | 240 W | pobór stacji GB10, pełna moc 24/7 jako górna granica |
| `smallPrefill` / `smallDecode` | 3 000 / 250 tok/s | ilustracyjne; pamięć ~273 GB/s ogranicza generowanie |

Parametry oprogramowania (sekcja „Oprogramowanie: Zagłoba RAG”):
`softApi` 5 000, `softCloud` 5 000 PLN / mies., `softLicense` 150 000 PLN,
`softSupport` 20 000 PLN / rok, `softAmort` 36 mies. Przy API doliczana jest
stała infrastruktura `apiOps` 1 000 PLN / mies. Koszty obsługi sprzętu
(`cloudOps`, `ownOps`, `smallOps`) domyślnie wynoszą 0.

Opcja jest przeznaczona dla małych wdrożeń: do **100 użytkowników** włącznie
(`smallMaxUsers` = 100) GB10 bierze udział w porównaniu; od 101 karta pokazuje
„Opcja niedostępna” i GB10 nie bierze udziału w porównaniu, paskach ani
wykresie. Poniżej limitu, gdy szczyt przekracza zadany limit wykorzystania,
kalkulator dolicza kolejne sztuki GB10. Wartości przepustowości trzeba
zmierzyć na własnym modelu przed decyzją.

Od **50 użytkowników** (`smallRecommendFrom`, edytowalne), gdy GB10 jest
najtańszy, karta GB10 zachowuje etykietę „Najtańsze”, a kolejna najtańsza
opcja dostaje etykietę „Rekomendowane” (`data-recommended` na karcie i
`#app[data-recommended]`). Poniżej progu, albo gdy GB10 nie wygrywa,
rekomendacja nie jest pokazywana.

## Dobór sprzętu do liczby użytkowników

W ustawieniach zaawansowanych parametr `maxUtilization` ustala maksymalne
wykorzystanie sprzętu (1–100%, domyślnie **80%**). Domyślnie zostaje więc
co najmniej 20% rezerwy obliczeniowej przy szacowanym szczycie. Kalkulator
sumuje obciążenie wejścia i wyjścia, dzieli je przez limit wykorzystania
i zaokrągla w górę do pełnych jednostek. Przy zerowym ruchu pozostaje jedna
jednostka, z jej normalnymi kosztami.

Jednostka oznacza kompletną konfigurację: instancję GPU w chmurze, własny
serwer albo stację GB10. Cena, moc i przepustowość w ustawieniach dotyczą
jednej takiej jednostki. Kolejne jednostki zwiększają koszt najmu albo
zakupu, amortyzacji, energii i wymiany sprzętu; stałe koszty obsługi oraz
oprogramowania nie są mnożone. Zmiana samego opisu GPU nie zmienia parametrów.

Karty pokazują liczbę jednostek, wykorzystanie w szczycie, limit oraz
szacowaną liczbę obsługiwanych i dodatkowych użytkowników. Pojemność dotyczy
bieżącego profilu na osobę (zapytania, kontekst, odpowiedź, język, myślenie,
godziny i szczyt), **nie liczby jednoczesnych sesji**. Przy braku obciążenia
tokenami pojemność z przepustowości nie jest wyznaczana. Limit wdrożenia GB10
pozostaje niezależny i obowiązuje także wtedy.

Przykłady przy pozostałych ustawieniach domyślnych:

| Użytkownicy | Chmura GPU | Własny serwer | GB10 |
| --- | --- | --- | --- |
| 20 | 1 instancja | 1 serwer | 1 stacja |
| 50 | 1 instancja | 1 serwer | 1 stacja |
| 100 | 1 instancja | 1 serwer | 2 stacje |
| 101 | 1 instancja | 1 serwer | niedostępne |
| 400 | 2 instancje | 2 serwery | niedostępne |

Przy 400 użytkownikach dwie instancje chmurowe obsługują szacunkowo do
740 osób, czyli zostaje miejsce na 340 dodatkowych użytkowników o tym samym
profilu. Ustawienie limitu 100% wyłącza rezerwę i przywraca wcześniejszy
model doboru liczby jednostek. To nadal szacunek: aplikacja nie weryfikuje
VRAM, dopasowania modelu do sprzętu ani opóźnień. Przed zakupem lub najmem
potrzebny jest test obciążeniowy własnej konfiguracji.

## Scenariusze i cennik

- **Zapisz lokalnie** zapisuje ustawienia i aktualny cennik w pamięci
  przeglądarki (klucz `quantica-aicalc-scenario-v2`; scenariusze zapisane
  przez oryginalny `aicalc` nie są odczytywane, bo nie mają pól GB10).
- **Eksport JSON** i **Import JSON** przenoszą scenariusz między
  przeglądarkami. Import jest walidowany przed zastosowaniem.
- Limit wykorzystania jest zapisywany i eksportowany wraz ze scenariuszem.
  Starsze pliki bez `maxUtilization` otrzymują wartość 80%; ich wyniki
  mogą więc wymagać większej liczby jednostek niż wcześniej.
- **Reset scenariusza** przywraca ustawienia kalkulatora i od razu zapisuje
  reset. Zaimportowany cennik pozostaje zachowany.
- **Cennik wbudowany** przywraca wyłącznie listę modeli dostarczoną z
  aplikacją. Schemat CSV jest taki sam jak w `aicalc` (17 kolumn, wzór do
  pobrania w aplikacji, limit 100 modeli i 1 MiB).

## Układ interfejsu

Na dużym ekranie ustawienia są w niezależnie przewijanym panelu po lewej
stronie: obciążenie (widoczne są trzy scenariusze, szczegóły zwinięte),
oprogramowanie Zagłoba RAG, model API, chmura GPU, Dell GB10, własny serwer,
zaawansowane, zapis. Po prawej: panel hero, cztery karty wyników, podsumowanie
z paskami i odpowiedziami, wykres kosztu narastającego, tabela modeli i testy.

Do 768 px panel ustawień staje się wysuwanym panelem; otwiera go przycisk
**Ustawienia**, zamyka przycisk w nagłówku, tło albo `Escape`.

Skróty: `1–3` scenariusze, `A` założenia, `L` język, `Ctrl/Cmd+S` zapis,
`↑/↓` w tabeli modeli.

## Kontrakt DOM

`#app` publikuje stan przez `data-*` (m.in. `data-winner`, `data-small-monthly`,
`data-small-units`, `data-recommended`, `data-break-even-small-users`, `data-payback-small-vs-cloud`,
`data-small-first-year`, `data-api-software`, `data-own-software`), a każda
karta wyniku `data-software` i `data-infra`. Limit wykorzystania jest
publikowany jako `#app[data-max-utilization]`. Karty sprzętowe publikują
`data-capacity-status` (`sized`, `idle`, `unavailable`, `invalid`),
`data-units`, `data-utilization`, `data-utilization-limit`,
`data-supported-users` i `data-remaining-users`. Wykorzystanie i limit w
kontrakcie są ułamkami (0–1). Brak wyznaczonej pojemności to pusty atrybut,
nie nieskończoność; przy niedostępnej opcji lub nieprawidłowych danych
wszystkie liczbowe atrybuty pojemności karty są puste.

Widoczne wartości mają `data-capacity-field` i są sprawdzane razem z
atrybutami karty. Tryb `?verify=1` uruchamia testy regresji, pojemności i
kontrakt DOM w samej aplikacji. Ten sam zestaw działa w testach Node i Chrome.

## Weryfikacja

```bash
node tests/core.test.cjs
node tests/scenario.test.cjs
node tests/layout.test.cjs
python3 tests/browser-smoke.py
```

Ostatni test uruchamia lokalny serwer i świeży profil Google Chrome/Chromium,
po czym sprawdza `?verify=1` przez `http://` i `file://`. Niczego nie
instaluje.

## English quick note

`aicalc-q` is the Quantica-styled fork of `aicalc`: a dependency-free,
single-file estimator of RAG inference costs across model API, cloud GPU,
a small Dell Pro Max GB10 deployment priced at PLN 35,000, and own server,
plus a Zagłoba RAG software layer (SaaS 5,000 PLN per month
with API/cloud; a 150,000 PLN licence with a 20,000 PLN yearly support
contract on hardware).
It is an estimate, not a quote or a capacity guarantee. Prices were checked on
14 Sep 2026; token factors and GB10 throughput are illustrative and editable.
