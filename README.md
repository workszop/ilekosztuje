# aicalc-q – kalkulator kosztów AI (Quantica Lab)

Jednoplikowy kalkulator porównujący miesięczny koszt asystenta RAG w czterech
wariantach:

1. płatne API modelu,
2. GPU w chmurze,
3. **małe wdrożenie na Dell Pro Max GB10** – pakiet wyceniony na **35 000 PLN**,
4. własny serwer (RTX PRO 6000).

Nad infrastrukturą liczona jest warstwa oprogramowania **Quantica Zagłoba RAG**:
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

Parametry oprogramowania (sekcja „Oprogramowanie: Quantica Zagłoba RAG”):
`softApi` 5 000, `softCloud` 5 000 PLN / mies., `softLicense` 150 000 PLN,
`softSupport` 20 000 PLN / rok, `softAmort` 36 mies. Przy API doliczana jest
stała infrastruktura `apiOps` 1 000 PLN / mies. Koszty obsługi sprzętu
(`cloudOps`, `ownOps`, `smallOps`) domyślnie wynoszą 0.

Gdy szczytowe obciążenie przekracza przepustowość, kalkulator dolicza kolejne
sztuki GB10 (przy scenariuszu „Firma · 300” są to trzy maszyny). Wartości
przepustowości trzeba zmierzyć na własnym modelu przed decyzją.

## Scenariusze i cennik

- **Zapisz lokalnie** zapisuje ustawienia i aktualny cennik w pamięci
  przeglądarki (klucz `quantica-aicalc-scenario-v2`; scenariusze zapisane
  przez oryginalny `aicalc` nie są odczytywane, bo nie mają pól GB10).
- **Eksport JSON** i **Import JSON** przenoszą scenariusz między
  przeglądarkami. Import jest walidowany przed zastosowaniem.
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
`data-small-units`, `data-break-even-small-users`, `data-payback-small-vs-cloud`,
`data-small-first-year`, `data-api-software`, `data-own-software`), a każda
karta wyniku `data-software` i `data-infra`. Tryb `?verify=1` uruchamia testy
regresji i kontrakt DOM w samej aplikacji (23 sprawdzenia).

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
plus a Quantica Zagłoba RAG software layer (SaaS 5,000 PLN per month
with API/cloud; a 150,000 PLN licence with a 20,000 PLN yearly support
contract on hardware).
It is an estimate, not a quote or a capacity guarantee. Prices were checked on
14 Sep 2026; token factors and GB10 throughput are illustrative and editable.
