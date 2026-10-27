/* Truck Deals — static listing browser. Display only. */
(function () {
  "use strict";

  var FILTER_KEY = "td_filters_v1";
  var THEME_KEY = "td_theme";
  var DATA_KEY = "td_last_data_v1";
  var PULL_THRESHOLD = 72;

  var FLAG_LABELS = {
    no_vin: "No VIN",
    curbstoner: "Curbstoner?",
    rebuilt: "Rebuilt title",
    possibly_unavailable: "Possibly unavailable",
    high_miles: "High miles",
    above_msrp: "Above MSRP",
    edge_of_radius: "Edge of radius",
    dually: "Dually",
    in_transit: "In transit",
    far: "Far",
    bed_unconfirmed: "Bed unconfirmed",
    axle_unconfirmed: "Axle unconfirmed",
    location_conflict: "Location conflict",
    price_drop: "Price drop",
    duplicate_post: "Duplicate post",
    stale_listing: "Stale listing",
    open_recall_risk: "Open recall risk",
    title_unknown: "Title unknown",
    below_market: "Below market",
    drive_unconfirmed: "Drive unconfirmed"
  };

  var state = {
    data: null,
    loading: false
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function isNum(value) {
    return typeof value === "number" && !isNaN(value);
  }

  function money(value) {
    if (!isNum(value)) return "";
    var cents = Math.round(value * 100) % 100;
    return (
      "$" +
      value.toLocaleString("en-US", {
        minimumFractionDigits: cents ? 2 : 0,
        maximumFractionDigits: cents ? 2 : 0
      })
    );
  }

  function intFmt(value) {
    if (!isNum(value)) return "";
    return Math.round(value).toLocaleString("en-US");
  }

  function formatDay(isoDate) {
    if (!isoDate) return "";
    var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate));
    if (!match) return String(isoDate);
    var date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function formatET(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return String(iso == null ? "" : iso);
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    }).formatToParts(date);
    function part(type) {
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === type) return parts[i].value;
      }
      return "";
    }
    var period = part("dayPeriod").toUpperCase();
    return part("month") + " " + part("day") + ", " + part("year") + ", " + part("hour") + ":" + part("minute") + " " + period + " ET";
  }

  /* Latest data date is the America/New_York calendar date of updated_at. */
  function latestDataDate(data) {
    if (data && data.updated_at) {
      var date = new Date(data.updated_at);
      if (!isNaN(date.getTime())) {
        var parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }).formatToParts(date);
        var year = "";
        var month = "";
        var day = "";
        for (var i = 0; i < parts.length; i++) {
          if (parts[i].type === "year") year = parts[i].value;
          if (parts[i].type === "month") month = parts[i].value;
          if (parts[i].type === "day") day = parts[i].value;
        }
        if (year && month && day) {
          return year + "-" + month.padStart(2, "0") + "-" + day.padStart(2, "0");
        }
      }
    }
    var max = "";
    var lists = []
      .concat((data && data.ranked) || [])
      .concat((data && data.conditional) || []);
    for (var j = 0; j < lists.length; j++) {
      var seen = lists[j] && lists[j].last_checked ? String(lists[j].last_checked).slice(0, 10) : "";
      if (seen > max) max = seen;
    }
    return max;
  }

  function dayKey(value) {
    if (!value) return "";
    return String(value).slice(0, 10);
  }

  function isNewListing(listing, latest) {
    return !!latest && dayKey(listing.first_seen) === latest;
  }

  function isDrop(listing) {
    return isNum(listing.price) && isNum(listing.prev) && listing.price < listing.prev;
  }

  function isFlagged(listing) {
    return Array.isArray(listing.flag_tags) && listing.flag_tags.length > 0;
  }

  function flagLabel(tag) {
    var key = String(tag);
    if (Object.prototype.hasOwnProperty.call(FLAG_LABELS, key)) return FLAG_LABELS[key];
    return key;
  }

  function groupEntries(groups) {
    if (!groups) return [];
    if (Array.isArray(groups)) {
      return groups.map(function (item, index) {
        var key = item && item.g != null ? String(item.g) : String(index + 1);
        var name = item && (item.name || item.grp) ? item.name || item.grp : "";
        return [key, name];
      });
    }
    return Object.keys(groups).map(function (key) {
      var value = groups[key];
      if (typeof value === "string") return [key, value];
      if (value && typeof value === "object") return [key, value.name || value.grp || ""];
      return [key, value == null ? "" : String(value)];
    });
  }

  function groupName(listing, data) {
    if (listing.grp) return String(listing.grp);
    var key = listing.g == null ? "" : String(listing.g);
    var entries = groupEntries(data && data.groups);
    for (var i = 0; i < entries.length; i++) {
      if (entries[i][0] === key) return entries[i][1];
    }
    return "";
  }

  function recallsOf(listing) {
    if (!Array.isArray(listing.rec)) return [];
    return listing.rec.filter(function (id) {
      return id != null && String(id) !== "";
    }).map(String);
  }

  function titleOf(listing) {
    return [listing.yr, listing.mk, listing.model, listing.trim].filter(function (part) {
      return part != null && String(part) !== "";
    }).join(" ");
  }

  function distanceText(value) {
    if (!isNum(value)) return "distance n/a";
    var rounded = Math.round(value * 10) / 10;
    var text = Math.abs(rounded - Math.round(rounded)) < 0.05 ? String(Math.round(rounded)) : rounded.toFixed(1);
    return text + " mi";
  }

  function payText(listing) {
    if (listing.pay) return String(listing.pay);
    if (isNum(listing.pay_lo) && isNum(listing.pay_hi)) {
      return money(listing.pay_lo) + "–" + money(listing.pay_hi) + "/mo";
    }
    return "";
  }

  function towText(listing) {
    if (listing.tow) return String(listing.tow);
    if (isNum(listing.tow_lb)) return intFmt(listing.tow_lb) + " lb conventional";
    return "";
  }

  function sellerText(listing) {
    if (listing.dealer === true) return "Dealer";
    if (listing.dealer === false) return "Private";
    return "";
  }

  function condText(listing) {
    if (listing.cond_new === true) return "New";
    if (listing.cond_new === false) return "Used";
    return "";
  }

  function safeHttpUrl(url) {
    if (typeof url !== "string" || !url) return "";
    try {
      var parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
    } catch (err) {
      return "";
    }
    return "";
  }

  function defaultFilters() {
    return {
      grades: ["A", "B", "C", "D"],
      priceMin: "",
      priceMax: "",
      maxMiles: "",
      maxDistance: 150,
      minTow: "",
      fuel: "any",
      cond: "any",
      newOnly: false,
      dropsOnly: false,
      hideFlagged: false,
      sort: "rank"
    };
  }

  function loadStoredFilters() {
    var filters = defaultFilters();
    try {
      var raw = localStorage.getItem(FILTER_KEY);
      if (!raw) return filters;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return filters;
      if (Array.isArray(parsed.grades)) {
        filters.grades = parsed.grades.filter(function (grade) {
          return grade === "A" || grade === "B" || grade === "C" || grade === "D";
        });
      }
      ["priceMin", "priceMax", "maxMiles", "minTow"].forEach(function (key) {
        if (parsed[key] != null) filters[key] = String(parsed[key]);
      });
      var distance = Number(parsed.maxDistance);
      if (isFinite(distance)) filters.maxDistance = Math.min(150, Math.max(0, Math.round(distance)));
      if (parsed.fuel === "gas" || parsed.fuel === "diesel" || parsed.fuel === "any") filters.fuel = parsed.fuel;
      if (parsed.cond === "new" || parsed.cond === "used" || parsed.cond === "any") filters.cond = parsed.cond;
      filters.newOnly = !!parsed.newOnly;
      filters.dropsOnly = !!parsed.dropsOnly;
      filters.hideFlagged = !!parsed.hideFlagged;
      var sorts = { rank: 1, price: 1, miles: 1, distance: 1, tow: 1, grade: 1, newest: 1 };
      if (sorts[parsed.sort]) filters.sort = parsed.sort;
    } catch (err) {}
    return filters;
  }

  function writeFiltersToDom(filters) {
    ["A", "B", "C", "D"].forEach(function (grade) {
      var box = document.querySelector('[data-testid="filter-grade-' + grade + '"]');
      if (box) box.checked = filters.grades.indexOf(grade) !== -1;
    });
    $("filter-price-min").value = filters.priceMin;
    $("filter-price-max").value = filters.priceMax;
    $("filter-max-miles").value = filters.maxMiles;
    $("filter-min-tow").value = filters.minTow;
    $("filter-max-distance").value = String(filters.maxDistance);
    $("dist-readout").textContent = filters.maxDistance + " mi";
    $("filter-fuel").value = filters.fuel;
    $("filter-cond").value = filters.cond;
    document.querySelector('[data-testid="filter-new-only"]').checked = filters.newOnly;
    document.querySelector('[data-testid="filter-drops-only"]').checked = filters.dropsOnly;
    document.querySelector('[data-testid="filter-hide-flagged"]').checked = filters.hideFlagged;
    $("sort-select").value = filters.sort;
  }

  function parseBound(value) {
    if (value == null) return null;
    var text = String(value).trim();
    if (!text) return null;
    var number = Number(text);
    return isFinite(number) ? number : null;
  }

  function readFiltersFromDom() {
    return {
      grades: ["A", "B", "C", "D"].filter(function (grade) {
        var box = document.querySelector('[data-testid="filter-grade-' + grade + '"]');
        return box && box.checked;
      }),
      priceMin: $("filter-price-min").value,
      priceMax: $("filter-price-max").value,
      maxMiles: $("filter-max-miles").value,
      maxDistance: Math.min(150, Math.max(0, Math.round(Number($("filter-max-distance").value) || 0))),
      minTow: $("filter-min-tow").value,
      fuel: $("filter-fuel").value,
      cond: $("filter-cond").value,
      newOnly: document.querySelector('[data-testid="filter-new-only"]').checked,
      dropsOnly: document.querySelector('[data-testid="filter-drops-only"]').checked,
      hideFlagged: document.querySelector('[data-testid="filter-hide-flagged"]').checked,
      sort: $("sort-select").value || "rank"
    };
  }

  function persistFilters(filters) {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
    } catch (err) {}
  }

  function fuelMatches(listing, want) {
    if (!want || want === "any") return true;
    var fuel = String(listing.fuel || "").toLowerCase();
    if (want === "gas") return fuel === "gas" || fuel === "gasoline";
    if (want === "diesel") return fuel === "diesel";
    return fuel === want;
  }

  function applyFilters(listings, filters, latest) {
    var priceMin = parseBound(filters.priceMin);
    var priceMax = parseBound(filters.priceMax);
    var maxMiles = parseBound(filters.maxMiles);
    var minTow = parseBound(filters.minTow);
    var gradeOn = {};
    filters.grades.forEach(function (grade) {
      gradeOn[grade] = true;
    });
    var allGrades = filters.grades.length === 4;
    return (listings || []).filter(function (listing) {
      var grade = String(listing.grade || "").toUpperCase();
      if (!allGrades && !gradeOn[grade]) return false;
      if (priceMin != null && (!isNum(listing.price) || listing.price < priceMin)) return false;
      if (priceMax != null && (!isNum(listing.price) || listing.price > priceMax)) return false;
      if (maxMiles != null && (!isNum(listing.mi) || listing.mi > maxMiles)) return false;
      if (!isNum(listing.d) || listing.d > filters.maxDistance) return false;
      if (minTow != null && (!isNum(listing.tow_lb) || listing.tow_lb < minTow)) return false;
      if (!fuelMatches(listing, filters.fuel)) return false;
      if (filters.cond === "new" && listing.cond_new !== true) return false;
      if (filters.cond === "used" && listing.cond_new !== false) return false;
      if (filters.newOnly && !isNewListing(listing, latest)) return false;
      if (filters.dropsOnly && !isDrop(listing)) return false;
      if (filters.hideFlagged && isFlagged(listing)) return false;
      return true;
    });
  }

  function cmpNullAsc(a, b) {
    var aOk = isNum(a);
    var bOk = isNum(b);
    if (!aOk && !bOk) return 0;
    if (!aOk) return 1;
    if (!bOk) return -1;
    return a - b;
  }

  function cmpRank(a, b) {
    function key(listing) {
      var rank = listing.rank;
      if (isNum(rank)) return [0, rank, ""];
      var text = rank == null ? "" : String(rank);
      if (/^\d+$/.test(text)) return [0, Number(text), ""];
      return [1, 0, text];
    }
    var ak = key(a);
    var bk = key(b);
    if (ak[0] !== bk[0]) return ak[0] - bk[0];
    if (ak[1] !== bk[1]) return ak[1] - bk[1];
    if (ak[2] < bk[2]) return -1;
    if (ak[2] > bk[2]) return 1;
    return 0;
  }

  function gradeOrder(grade) {
    var order = { A: 0, B: 1, C: 2, D: 3 };
    var key = String(grade || "").toUpperCase();
    return Object.prototype.hasOwnProperty.call(order, key) ? order[key] : 9;
  }

  function sortListings(listings, mode) {
    var decorated = listings.map(function (listing, index) {
      return { listing: listing, index: index };
    });
    decorated.sort(function (a, b) {
      var cmp = 0;
      if (mode === "price") cmp = cmpNullAsc(a.listing.price, b.listing.price);
      else if (mode === "miles") cmp = cmpNullAsc(a.listing.mi, b.listing.mi);
      else if (mode === "distance") cmp = cmpNullAsc(a.listing.d, b.listing.d);
      else if (mode === "tow") cmp = cmpNullAsc(a.listing.tow_lb, b.listing.tow_lb);
      else if (mode === "grade") cmp = gradeOrder(a.listing.grade) - gradeOrder(b.listing.grade);
      else if (mode === "newest") {
        var as = dayKey(a.listing.first_seen);
        var bs = dayKey(b.listing.first_seen);
        if (!as && !bs) cmp = 0;
        else if (!as) cmp = 1;
        else if (!bs) cmp = -1;
        else if (as < bs) cmp = 1;
        else if (as > bs) cmp = -1;
      } else cmp = cmpRank(a.listing, b.listing);
      return cmp !== 0 ? cmp : a.index - b.index;
    });
    return decorated.map(function (item) {
      return item.listing;
    });
  }

  function badgeHtml(listing, latest) {
    var html = "";
    if (isNewListing(listing, latest)) {
      html += '<span class="badge badge-new" data-testid="badge-new">NEW</span>';
    }
    if (isDrop(listing)) {
      html +=
        '<span class="badge badge-drop" data-testid="badge-drop">PRICE DROP ' +
        esc(money(listing.prev - listing.price)) +
        "</span>";
    }
    return html;
  }

  function flagHtml(listing) {
    if (!Array.isArray(listing.flag_tags) || !listing.flag_tags.length) return "";
    return (
      '<p class="flag-row">' +
      listing.flag_tags
        .map(function (tag) {
          return '<span class="flag">' + esc(flagLabel(tag)) + "</span>";
        })
        .join("") +
      "</p>"
    );
  }

  function cardHtml(listing, latest) {
    var data = state.data || {};
    var grade = String(listing.grade || "").toUpperCase();
    var miles = isNum(listing.mi) ? intFmt(listing.mi) + " mi" : "";
    var cond = condText(listing);
    var milesLine = [miles, cond].filter(Boolean).join(" · ");
    var cabLine = [listing.cab, listing.drv].filter(function (part) {
      return part != null && String(part) !== "";
    }).join(" · ");
    var price = isNum(listing.price) ? money(listing.price) : "Price unavailable";
    var was = isDrop(listing) ? '<span class="was">' + esc(money(listing.prev)) + "</span>" : "";
    var locBits = [];
    if (listing.loc) locBits.push(esc(listing.loc));
    locBits.push(esc(distanceText(listing.d)));
    var pay = payText(listing);
    var tow = towText(listing);
    var recallCount = recallsOf(listing).length;
    var recallLabel = recallCount === 1 ? "1 recall" : recallCount + " recalls";
    if (recallCount === 0) recallLabel = "No recalls";
    var seen = [];
    if (listing.first_seen) seen.push("First seen " + formatDay(listing.first_seen));
    if (listing.last_checked) seen.push("Last checked " + formatDay(listing.last_checked));
    var group = groupName(listing, data);
    return (
      '<article class="card" data-testid="card" data-rank="' +
      esc(listing.rank) +
      '" data-grade="' +
      esc(grade) +
      '" role="button" tabindex="0">' +
      '<div class="card-top"><span class="rank">' +
      esc(listing.rank) +
      '</span><span class="grade grade-' +
      esc(grade) +
      '">' +
      esc(grade || "–") +
      "</span>" +
      (group ? '<span class="grp">' + esc(group) + "</span>" : "") +
      '<span class="badges">' +
      badgeHtml(listing, latest) +
      "</span></div>" +
      '<h3 class="title">' +
      esc(titleOf(listing)) +
      "</h3>" +
      (listing.eng ? '<p class="sub">' + esc(listing.eng) + "</p>" : "") +
      (cabLine ? '<p class="sub">' + esc(cabLine) + "</p>" : "") +
      (milesLine ? '<p class="sub">' + esc(milesLine) + "</p>" : "") +
      '<p class="price">' +
      esc(price) +
      was +
      "</p>" +
      '<p class="loc">' +
      locBits.join(" · ") +
      "</p>" +
      (tow ? '<p class="tow">Conventional tow ' + esc(tow) + "</p>" : "") +
      (pay ? '<p class="pay">' + esc(pay) + ' <span class="info">info only</span></p>' : "") +
      '<p class="sub">' +
      esc(recallLabel) +
      "</p>" +
      flagHtml(listing) +
      (seen.length ? '<p class="seen">' + esc(seen.join(" · ")) + "</p>" : "") +
      "</article>"
    );
  }

  function sectionHtml(title, label, listings, latest) {
    var cards = listings.map(function (listing) {
      return cardHtml(listing, latest);
    }).join("");
    var body = cards ? '<div class="cards">' + cards + "</div>" : '<p class="empty">None in this section.</p>';
    return (
      '<section class="section"><h2><span>' +
      esc(title) +
      "</span>" +
      (label ? '<span class="section-label">' + esc(label) + "</span>" : "") +
      '<span class="count">' +
      listings.length +
      "</span></h2>" +
      body +
      "</section>"
    );
  }

  function renderList() {
    var list = $("list");
    var count = $("result-count");
    if (!state.data) {
      list.innerHTML = '<p class="empty">Loading listings…</p>';
      count.textContent = "";
      return;
    }
    var filters = readFiltersFromDom();
    var latest = latestDataDate(state.data);
    var ranked = sortListings(applyFilters(state.data.ranked || [], filters, latest), filters.sort);
    var conditional = sortListings(applyFilters(state.data.conditional || [], filters, latest), filters.sort);
    var total = (state.data.ranked || []).length + (state.data.conditional || []).length;
    count.textContent = "Showing " + (ranked.length + conditional.length) + " of " + total;
    list.innerHTML = sectionHtml("Ranked", "", ranked, latest) + sectionHtml("Conditional", "needs a check", conditional, latest);
  }

  function renderUpdated() {
    var el = $("last-updated");
    if (state.data && state.data.updated_at) {
      el.textContent = "Last updated " + formatET(state.data.updated_at);
    } else {
      el.textContent = "Last updated …";
    }
  }

  function renderSpecs() {
    var host = $("specs-body");
    var data = state.data;
    if (!data) {
      host.innerHTML = '<p class="empty">Loading search specs…</p>';
      return;
    }
    var specs = data.specs || {};
    var criteria = Array.isArray(specs.criteria) ? specs.criteria : [];
    var criteriaHtml = criteria
      .map(function (item) {
        var text = typeof item === "string" ? item : JSON.stringify(item);
        return "<li>" + esc(text) + "</li>";
      })
      .join("");
    var groupsHtml = groupEntries(data.groups)
      .map(function (entry) {
        return "<li><strong>" + esc(entry[0]) + "</strong> " + esc(entry[1]) + "</li>";
      })
      .join("");
    host.innerHTML =
      '<article class="specs-card"><h2>Search specs</h2>' +
      "<p><strong>Center.</strong> " +
      esc(specs.center || "Hudson FL") +
      "</p>" +
      "<p><strong>Radius.</strong> " +
      esc(specs.radius_mi != null ? specs.radius_mi + " mi" : "150 mi") +
      "</p>" +
      (criteriaHtml ? "<h3>Criteria</h3><ul>" + criteriaHtml + "</ul>" : "") +
      (specs.notes ? "<h3>Notes</h3><p>" + esc(specs.notes) + "</p>" : "") +
      "</article>" +
      '<article class="specs-card"><h2>Groups</h2><ul class="group-list">' +
      (groupsHtml || "<li>No groups in this file.</li>") +
      "</ul></article>" +
      (data.sources
        ? '<article class="specs-card"><h2>Sources</h2><p>' + esc(data.sources) + "</p></article>"
        : "");
  }

  function findListing(rank) {
    var key = String(rank);
    var lists = []
      .concat((state.data && state.data.ranked) || [])
      .concat((state.data && state.data.conditional) || []);
    for (var i = 0; i < lists.length; i++) {
      if (String(lists[i].rank) === key) return lists[i];
    }
    return null;
  }

  function rowText(label, value) {
    if (value == null || value === "") return "";
    return '<div class="row"><span class="rk">' + esc(label) + '</span><span class="rv">' + esc(value) + "</span></div>";
  }

  function rowHtml(label, html) {
    return '<div class="row"><span class="rk">' + esc(label) + '</span><span class="rv">' + html + "</span></div>";
  }

  function sparkline(points) {
    var prices = points
      .map(function (point) {
        return Number(point && point.price);
      })
      .filter(function (price) {
        return isFinite(price);
      });
    if (prices.length < 2) return "";
    var width = 280;
    var height = 48;
    var pad = 4;
    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    var span = max - min || 1;
    var coords = prices.map(function (price, index) {
      var x = pad + (index * (width - pad * 2)) / (prices.length - 1);
      var y = pad + (1 - (price - min) / span) * (height - pad * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    return (
      '<svg class="spark" viewBox="0 0 ' +
      width +
      " " +
      height +
      '" width="100%" height="48" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="3" points="' +
      coords.join(" ") +
      '"/></svg>'
    );
  }

  function historyHtml(listing) {
    var points = Array.isArray(listing.price_history) ? listing.price_history : null;
    var inner;
    if (!points || !points.length) {
      inner = "<p>No price history</p>";
    } else {
      inner =
        sparkline(points) +
        '<ul class="history-list">' +
        points
          .map(function (point) {
            var date = point && point.date ? formatDay(point.date) : "";
            var price = point && isNum(point.price) ? money(point.price) : point && point.price != null ? String(point.price) : "";
            return "<li>" + esc([date, price].filter(Boolean).join(" · ")) + "</li>";
          })
          .join("") +
        "</ul>";
    }
    return '<section data-testid="price-history"><h3>Price history</h3>' + inner + "</section>";
  }

  function renderDetail(rank) {
    var body = $("detail-body");
    var foot = $("detail-foot");
    var kicker = $("detail-kicker");
    if (!state.data) {
      kicker.textContent = "Listing";
      body.innerHTML = '<p class="empty">Loading listing…</p>';
      foot.innerHTML = "";
      return;
    }
    var listing = findListing(rank);
    if (!listing) {
      kicker.textContent = "Listing";
      body.innerHTML = '<p class="empty">This listing is not in the current file.</p>';
      foot.innerHTML = "";
      return;
    }
    var latest = latestDataDate(state.data);
    var grade = String(listing.grade || "").toUpperCase();
    var vin = typeof listing.vin === "string" && listing.vin.trim() ? listing.vin.trim() : "";
    var vinHtml = vin
      ? '<span class="vin-line"><span>' +
        esc(vin) +
        '</span> <button type="button" class="btn btn-small" data-testid="vin-copy" data-vin="' +
        esc(vin) +
        '">Copy VIN</button></span>'
      : "No VIN";
    var recallLinks = recallsOf(listing)
      .map(function (id) {
        var href = "https://www.nhtsa.gov/recalls?nhtsaId=" + encodeURIComponent(id);
        return (
          '<a class="recall-link" data-testid="recall-link" href="' +
          esc(href) +
          '" target="_blank" rel="noopener noreferrer">' +
          esc(id) +
          "</a>"
        );
      })
      .join("");
    var docFee = isNum(listing.doc) ? money(listing.doc) : "";
    var seller = sellerText(listing);
    var sellerDoc = [seller, docFee ? "Doc fee " + docFee : ""].filter(Boolean).join(" · ");
    kicker.textContent = "Rank " + listing.rank;
    body.innerHTML =
      '<article class="detail-card">' +
      '<div class="badges">' +
      (grade ? '<span class="grade grade-' + esc(grade) + '">' + esc(grade) + "</span>" : "") +
      badgeHtml(listing, latest) +
      "</div>" +
      "<h3>" +
      esc(titleOf(listing)) +
      "</h3>" +
      (listing.eng ? "<p>" + esc(listing.eng) + "</p>" : "") +
      '<p class="price">' +
      esc(isNum(listing.price) ? money(listing.price) : "Price unavailable") +
      (isDrop(listing) ? ' <span class="was">' + esc(money(listing.prev)) + "</span>" : "") +
      "</p>" +
      rowText("Group", groupName(listing, state.data)) +
      rowText("Status", listing.status) +
      rowText("Cab / bed", listing.cab) +
      rowText("Drive", listing.drv) +
      rowText("Miles", isNum(listing.mi) ? intFmt(listing.mi) + " mi" : "") +
      rowText("Condition", condText(listing)) +
      rowText("Fuel", listing.fuel) +
      rowText("Location", listing.loc) +
      rowText("Distance", distanceText(listing.d)) +
      rowHtml("VIN", vinHtml) +
      rowText("Conventional tow", towText(listing)) +
      rowHtml("Tow source", '<span data-testid="tow-source">' + esc(listing.tsrc || "No tow source listed") + "</span>") +
      rowHtml("Recalls", recallLinks || "No recalls") +
      rowText("Payment", payText(listing) ? payText(listing) + " (estimate, info only)" : "") +
      rowText("Seller", sellerDoc) +
      rowText("Source", listing.src) +
      rowText("Flags", listing.flags || (isFlagged(listing) ? "" : "No flags")) +
      flagHtml(listing) +
      rowText("First seen", listing.first_seen ? formatDay(listing.first_seen) : "") +
      rowText("Last checked", listing.last_checked ? formatDay(listing.last_checked) : "") +
      historyHtml(listing) +
      "</article>";
    body.scrollTop = 0;
    var href = safeHttpUrl(listing.url);
    foot.innerHTML = href
      ? '<a class="open-listing" data-testid="open-listing" href="' +
        esc(href) +
        '" target="_blank" rel="noopener noreferrer">Open listing</a>'
      : "";
  }

  function parseRoute() {
    var hash = location.hash || "";
    if (hash === "#/specs" || hash === "#specs") return { view: "specs" };
    var match = /^#\/l\/(.+)$/.exec(hash);
    if (match) return { view: "detail", rank: decodeURIComponent(match[1]) };
    return { view: "list" };
  }

  function applyRoute() {
    var route = parseRoute();
    var listView = $("list-view");
    var specs = $("specs-view");
    var detail = $("detail");
    var wasHidden = detail.hidden;
    var onSpecs = route.view === "specs";
    var onDetail = route.view === "detail";
    listView.hidden = onSpecs;
    specs.hidden = !onSpecs;
    detail.hidden = !onDetail;
    document.body.classList.toggle("detail-open", onDetail);
    $("nav-specs").setAttribute("aria-current", onSpecs ? "page" : "false");
    $("nav-list").setAttribute("aria-current", onSpecs ? "false" : "page");
    if (onDetail) {
      renderDetail(route.rank);
      if (wasHidden) $("detail-back").focus();
    }
  }

  function showOfflineNotice(data) {
    var el = $("offline-notice");
    el.hidden = false;
    if (data && data.updated_at) {
      el.textContent = "offline, showing data from " + formatET(data.updated_at);
    } else {
      el.textContent = "offline, no saved listings on this device";
    }
  }

  function hideOfflineNotice() {
    var el = $("offline-notice");
    el.hidden = true;
    el.textContent = "";
  }

  function readSavedData() {
    try {
      var raw = localStorage.getItem(DATA_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (err) {}
    return null;
  }

  function useSavedData() {
    var saved = readSavedData() || state.data;
    if (saved) {
      state.data = saved;
      showOfflineNotice(saved);
      renderUpdated();
      renderSpecs();
      renderList();
      applyRoute();
      return;
    }
    showOfflineNotice(null);
    $("list").innerHTML = '<p class="empty">No saved listings on this device.</p>';
    $("result-count").textContent = "";
  }

  function loadData() {
    if (state.loading) return;
    state.loading = true;
    var button = $("refresh-btn");
    button.disabled = true;
    button.textContent = "Refreshing…";
    var done = function () {
      state.loading = false;
      button.disabled = false;
      button.textContent = "Refresh";
    };
    if (navigator.onLine === false) {
      useSavedData();
      done();
      return;
    }
    fetch("./data.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error(String(res.status));
        var fromCache = res.headers.get("X-TD-Source") === "cache";
        return res.json().then(function (data) {
          return { data: data, fromCache: fromCache };
        });
      })
      .then(function (result) {
        if (!result.data || typeof result.data !== "object") throw new Error("bad json");
        try {
          localStorage.setItem(DATA_KEY, JSON.stringify(result.data));
        } catch (err) {}
        state.data = result.data;
        if (result.fromCache || navigator.onLine === false) showOfflineNotice(result.data);
        else hideOfflineNotice();
        renderUpdated();
        renderSpecs();
        renderList();
        applyRoute();
      })
      .catch(function () {
        useSavedData();
      })
      .then(done, done);
  }

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    if (!ok) throw new Error("copy failed");
  }

  function copyVin(button) {
    var vin = button.getAttribute("data-vin") || "";
    if (!vin) return;
    var finish = function () {
      button.textContent = "Copied";
      setTimeout(function () {
        if (button.isConnected) button.textContent = "Copy VIN";
      }, 1500);
    };
    var fail = function () {
      button.textContent = "Copy failed";
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(vin).then(finish, function () {
          try {
            fallbackCopy(vin);
            finish();
          } catch (err) {
            fail();
          }
        });
        return;
      }
      fallbackCopy(vin);
      finish();
    } catch (err) {
      fail();
    }
  }

  function syncThemeButton() {
    var theme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    var button = $("theme-toggle");
    button.textContent = theme === "light" ? "Dark" : "Light";
    button.setAttribute("aria-label", theme === "light" ? "Switch to dark theme" : "Switch to light theme");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f3f6f4" : "#0e1512");
  }

  function toggleTheme() {
    var theme = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (err) {}
    syncThemeButton();
  }

  function onFilterInput() {
    var filters = readFiltersFromDom();
    $("dist-readout").textContent = filters.maxDistance + " mi";
    persistFilters(filters);
    renderList();
  }

  function clearFilters() {
    var filters = defaultFilters();
    writeFiltersToDom(filters);
    persistFilters(filters);
    renderList();
  }

  function openRank(rank) {
    if (rank == null || rank === "") return;
    location.hash = "#/l/" + encodeURIComponent(String(rank));
  }

  function bindPullToRefresh() {
    var startY = null;
    var delta = 0;
    var indicator = $("pull-indicator");

    function reset() {
      startY = null;
      delta = 0;
      indicator.hidden = true;
    }

    document.addEventListener(
      "touchstart",
      function (event) {
        if (!$("detail").hidden || window.scrollY > 0 || event.touches.length !== 1) {
          reset();
          return;
        }
        startY = event.touches[0].clientY;
        delta = 0;
      },
      { passive: true }
    );

    document.addEventListener(
      "touchmove",
      function (event) {
        if (startY == null) return;
        delta = event.touches[0].clientY - startY;
        if (delta > 12 && window.scrollY <= 0) {
          indicator.hidden = false;
          indicator.textContent = delta > PULL_THRESHOLD ? "Release to refresh" : "Pull to refresh";
        } else if (delta <= 0) {
          indicator.hidden = true;
        }
      },
      { passive: true }
    );

    document.addEventListener(
      "touchend",
      function () {
        if (startY != null && delta > PULL_THRESHOLD && window.scrollY <= 0) loadData();
        reset();
      },
      { passive: true }
    );

    document.addEventListener("touchcancel", reset, { passive: true });
  }

  function bind() {
    $("theme-toggle").addEventListener("click", toggleTheme);
    $("refresh-btn").addEventListener("click", loadData);
    $("filter-clear").addEventListener("click", clearFilters);
    $("filter-panel").addEventListener("input", onFilterInput);
    $("filter-panel").addEventListener(
      "wheel",
      function (event) {
        var target = event.target;
        if (target && target.type === "number" && document.activeElement === target) target.blur();
      },
      { passive: true }
    );
    $("nav-list").addEventListener("click", function () {
      if ((location.hash || "#/") === "#/") applyRoute();
      else location.hash = "#/";
    });
    $("nav-specs").addEventListener("click", function () {
      location.hash = "#/specs";
    });
    $("detail-back").addEventListener("click", function () {
      location.hash = "#/";
    });
    $("list").addEventListener("click", function (event) {
      var card = event.target.closest("[data-testid='card']");
      if (!card || !$("list").contains(card)) return;
      openRank(card.getAttribute("data-rank"));
    });
    $("list").addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      var card = event.target.closest("[data-testid='card']");
      if (!card || !$("list").contains(card)) return;
      event.preventDefault();
      openRank(card.getAttribute("data-rank"));
    });
    $("detail").addEventListener("click", function (event) {
      var button = event.target.closest("[data-testid='vin-copy']");
      if (!button || !$("detail").contains(button)) return;
      copyVin(button);
    });
    window.addEventListener("hashchange", applyRoute);
    bindPullToRefresh();
  }

  function registerWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(function () {});
  }

  bind();
  syncThemeButton();
  writeFiltersToDom(loadStoredFilters());
  $("list").innerHTML = '<p class="empty">Loading listings…</p>';
  applyRoute();
  loadData();
  registerWorker();
})();
