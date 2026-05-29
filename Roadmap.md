# Political View – Roadmap for Next Release

This document outlines the features and improvements planned for the next major version of **Political View**. The goal is to expand the tool beyond election visualisations, offering deeper insights into WarEra’s political landscape – parties, members, and their activity.

---

## 🎯 Core New Feature: Dedicated Party Page

A standalone page (or modal) for each party, accessible from anywhere a party is mentioned (e.g., in parliament tables, charts, or the simulator).

### Functional requirements

- **Party overview**  
  - Party name, abbreviation, colour, logo/avatar (if available).  
  - Ideology / ethics (militarism, isolationism, imperialism, industrialism) if exposed by API.  
  - Country of registration and region.

- **Members section**  
  - List of all party members (avatars, usernames, links to profiles).  
  - **Active members** – members who logged in within the last X days (configurable, e.g., 7 or 30 days).  
  - **Member count** and **active member count** displayed as badges.  
  - Sorting options (by name, join date, activity, damages, wealth, etc.).

- **Statistics & rankings**  
  - Party rankings: total damages, weekly damages, bounty, terrain, wealth (from API `rankings` object).  
  - Graphical representation of growth over time (if historical data is available).  
  - Comparison with other parties in the same country.

- **Leadership & roles**  
  - Show managers, commanders, treasurer, primary winner (if available).  
  - Clear visual distinction of roles.

- **Filtering**  
  - **By country**: filter parties shown in search / selection.  
  - **By party name**: live search / autocomplete.  
  - **By active status**: show only parties with active members above a threshold.

- **Links & navigation**  
  - Direct link to the party’s WarEra page.  
  - Link back to the election / parliament view where the party is present.

---

## 📊 Additional Ideas for Future Versions

### 1. **Historical party evolution**
- Show how a party’s seat count and member count changed across different congressional elections (timeline chart on the party page).
- Track coalition formation and dissolution over time.

### 2. **User profile integration**
- When clicking on a user (avatar / username), show a summary of their political career:  
  - Party memberships (past and present).  
  - Elections won (president, congress member).  
  - Government roles held (minister, vice president, president).  
  - Activity metrics (damages, wealth, level, last connection).

### 3. **Advanced filtering on parliament view**
- Filter the parliament SVG by party or by member activity.  
- Highlight seats held by parties with a certain ideology or above a member threshold.

### 4. **Export enhancements**
- Export party member lists (CSV, JSON).  
- Export the full government timeline for a country.

### 5. **Real‑time or near‑real‑time updates**
- WebSocket or periodic polling to update ongoing elections (vote counts) without manual refresh.  
- Live indicator for elections that are currently open.

### 6. **More simulator options**
- Adjust voter turnout based on historical patterns, not just expected voters.  
- Simulate coalition building after the election: given a set of parties, which coalitions reach the majority threshold?

### 7. **Accessibility & internationalisation**
- Keyboard navigation improvements for charts and tables.  
- Translations (Italian, English, other languages).  
- Better ARIA labels for screen readers.

### 8. **API cache management**
- User‑controlled cache expiry per data type (countries, elections, parties, users).  
- Clear cache for a specific country only.

### 9. **Dark / light theme customisation**
- Allow users to pick accent colours (gold, blue, etc.) independently of the theme.  
- Save theme preferences per device (already implemented) and per country (optional).

### 10. **Performance optimisations**
- Virtualised tables for very long party member lists.  
- Lazy loading of images (avatars) when scrolling.  
- Defer loading of non‑visible charts (e.g., inside collapsed panels).

---

## 🧭 Implementation Priorities

1. **Party page with member list and basic stats** – highest impact.  
2. **Country filtering for parties** – essential for usability.  
3. **Historical seat/member timeline for parties** – adds depth.  
4. **User profile popup / modal** – integrates individual data.  
5. **Advanced simulator & coalition builder** – longer term.

---

## 📌 Notes

- All new features will respect the existing API rate limits and caching strategy.  
- The party page will be built using the existing `/party` endpoint (if it returns members) and possibly a new aggregation endpoint for member activity (to be discussed with the API provider).  
- Contributions and suggestions are welcome via GitHub issues.

---

**Last updated:** May 2026  
**Project maintainer:** frappa10