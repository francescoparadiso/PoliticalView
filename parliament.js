let _lastRenderData = null;   // salva { parties, container, legendContainer, tooltip }

const Parliament = (() => {

  function computeLayout(nSeats, innerR, outerR) {
    if (nSeats <= 0) return null;
    for (let nRows = 2; nRows <= 12; nRows++) {
      const rowSpan = outerR - innerR;
      const rowH = rowSpan / Math.max(nRows - 1, 1);
      const dotR = rowH * 0.28;
      const step = dotR * 2 * 1.10;
      const radii = Array.from({ length: nRows }, (_, i) => innerR + rowH * i);
      const caps = radii.map(r => Math.max(1, Math.floor(Math.PI * r / step)));
      const total = caps.reduce((a, b) => a + b, 0);
      if (total >= nSeats) {
        const rowSeats = _distributePro(nSeats, caps);
        return { dotR, radii, rowSeats };
      }
    }
    const nRows = 12;
    const rowH = (outerR - innerR) / (nRows - 1);
    const dotR = rowH * 0.28;
    const step = dotR * 2 * 1.10;
    const radii = Array.from({ length: nRows }, (_, i) => innerR + rowH * i);
    const caps = radii.map(r => Math.max(1, Math.floor(Math.PI * r / step)));
    const rowSeats = _distributePro(nSeats, caps);
    return { dotR, radii, rowSeats };
  }

  function _distributePro(total, caps) {
    const capSum = caps.reduce((a, b) => a + b, 0);
    const result = new Array(caps.length).fill(0);
    let assigned = 0;
    caps.forEach((cap, i) => {
      if (i === caps.length - 1) {
        result[i] = total - assigned;
      } else {
        const s = Math.min(cap, Math.round(total * cap / capSum));
        result[i] = s;
        assigned += s;
      }
    });
    let diff = total - result.reduce((a, b) => a + b, 0);
    for (let i = caps.length - 1; i >= 0 && diff !== 0; i--) {
      const canAdd = caps[i] - result[i];
      const canSub = result[i];
      if (diff > 0 && canAdd > 0) {
        const add = Math.min(diff, canAdd);
        result[i] += add;
        diff -= add;
      } else if (diff < 0 && canSub > 0) {
        const sub = Math.min(-diff, canSub);
        result[i] -= sub;
        diff += sub;
      }
    }
    return result;
  }

  function generatePoints(layout) {
    const { radii, rowSeats } = layout;
    const pts = [];
    radii.forEach((radius, row) => {
      const n = rowSeats[row];
      if (n <= 0) return;
      for (let i = 0; i < n; i++) {
        const angle = -Math.PI + Math.PI * (i / (n - 1 || 1));
        pts.push({ angle, radius, row });
      }
    });
    pts.sort((a, b) => a.angle - b.angle);
    return pts;
  }

  function render({ container, legendContainer, parties, tooltip }) {
    container.innerHTML = '';
    legendContainer.innerHTML = '';

    const totalSeats = parties.reduce((s, p) => s + p.seats, 0);
    if (!totalSeats) {
      container.innerHTML = '<p class="empty">Nessun seggio disponibile.</p>';
      return;
    }

// ✅ FIX MOBILE: usa larghezza reale, minimo più basso su schermi piccoli
let W = container.clientWidth || window.innerWidth;
const isMobile = W < 600;
if (!W || W < (isMobile ? 260 : 340)) {
  W = isMobile ? 260 : 340;
}
    const H = Math.round(W * 0.55);
    const cx = W / 2;
    const cy = H * 0.90;
    const outerR = Math.min(W * 0.47, H * 0.93);
    const innerR = outerR * 0.24;

    const layout = computeLayout(totalSeats, innerR, outerR);
    if (!layout) return;

    const pts = generatePoints(layout);
    const sorted = [...parties].sort((a, b) => b.seats - a.seats);
    let idx = 0;
    const colored = [];
    sorted.forEach(party => {
      const users = party.users || [];
      for (let i = 0; i < party.seats; i++) {
        if (idx >= pts.length) break;
        colored.push({
          ...pts[idx],
          party: party.name,
          partyId: party.id || null,
          color: party.color,
          seatIdx: i,
          total: party.seats,
          username: users[i]?.username || null,
          userId: users[i]?.userId || null,
          avatarUrl: users[i]?.avatarUrl || null,
        });
        idx++;
      }
    });

    // Calcolo majority e angolo prima di usarli per il bounding box
    const majority = Math.floor(totalSeats / 2) + 1;
    const majAngle = -Math.PI + Math.PI * (majority / totalSeats);

    // Calcola i limiti di tutti gli elementi (pallini, linee, testo)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    colored.forEach(d => {
      const x = cx + d.radius * Math.cos(d.angle);
      const y = cy + d.radius * Math.sin(d.angle);
      minX = Math.min(minX, x - layout.dotR);
      minY = Math.min(minY, y - layout.dotR);
      maxX = Math.max(maxX, x + layout.dotR);
      maxY = Math.max(maxY, y + layout.dotR);
    });

    const lx1 = cx + (innerR - 6) * Math.cos(majAngle);
    const ly1 = cy + (innerR - 6) * Math.sin(majAngle);
    const lx2 = cx + (outerR + 6) * Math.cos(majAngle);
    const ly2 = cy + (outerR + 6) * Math.sin(majAngle);
    minX = Math.min(minX, lx1, lx2);
    maxX = Math.max(maxX, lx1, lx2);
    minY = Math.min(minY, ly1, ly2);
    maxY = Math.max(maxY, ly1, ly2);

    const textX = cx + (outerR + 13) * Math.cos(majAngle);
    const textY = cy + (outerR + 13) * Math.sin(majAngle) + 3;
    minX = Math.min(minX, textX - 20);
    maxX = Math.max(maxX, textX + 20);
    minY = Math.min(minY, textY - 10);
    maxY = Math.max(maxY, textY + 10);

    const centerTextY = cy - 6;
    minX = Math.min(minX, cx - 30);
    maxX = Math.max(maxX, cx + 30);
    minY = Math.min(minY, centerTextY - 10);
    maxY = Math.max(maxY, centerTextY + 10);

    minX = Math.min(minX, cx - outerR - layout.dotR - 10);
    maxX = Math.max(maxX, cx + outerR + layout.dotR + 10);
    minY = Math.min(minY, cy - outerR - layout.dotR - 10);
    maxY = Math.max(maxY, cy + 10);

    const padding = 10;
    const viewBoxX = minX - padding;
    const viewBoxY = minY - padding;
    const viewBoxW = maxX - minX + 2 * padding;
    const viewBoxH = maxY - minY + 2 * padding;

    const svg = d3.select(container)
      .append('svg')
      .attr('viewBox', `${viewBoxX} ${viewBoxY} ${viewBoxW} ${viewBoxH}`)
      .style('width', '100%')
      .style('height', 'auto')
      .style('overflow', 'visible');

    const defs = svg.append('defs');
    colored.forEach(d => {
      if (d.avatarUrl) {
        const patternId = 'avatar-' + d.userId;
        if (!svg.select(`#${patternId}`).size()) {
          const pattern = defs.append('pattern')
            .attr('id', patternId)
            .attr('patternUnits', 'objectBoundingBox')
            .attr('width', 1)
            .attr('height', 1);
          pattern.append('image')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', 1)
            .attr('height', 1)
            .attr('preserveAspectRatio', 'xMidYMid slice')
            .attr('href', d.avatarUrl);
        }
      }
    });

    const arcPath = (r) => `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
    svg.append('path').attr('d', arcPath(outerR + layout.dotR + 2))
      .attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.04)').attr('stroke-width', layout.dotR * 2 + 4);
    svg.append('path').attr('d', arcPath(outerR + layout.dotR + 2))
      .attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.06)').attr('stroke-width', 0.5);
    svg.append('path').attr('d', arcPath(innerR - layout.dotR - 2))
      .attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.06)').attr('stroke-width', 0.5);

    svg.append('line')
      .attr('x1', lx1).attr('y1', ly1)
      .attr('x2', lx2).attr('y2', ly2)
      .attr('stroke', 'rgba(197,150,74,.55)')
      .attr('stroke-width', 1.2)
      .attr('stroke-dasharray', '3 3');

    svg.append('text')
      .attr('x', textX)
      .attr('y', textY)
      .attr('fill', 'rgba(197,150,74,.7)')
      .attr('font-size', 9)
      .attr('font-family', 'Sora, sans-serif')
      .text('50%+1');

    svg.selectAll('g.seat-group')
      .data(colored)
      .enter()
      .append('g')
      .attr('class', 'seat-group')
      .attr('transform', d => `translate(${cx + d.radius * Math.cos(d.angle)}, ${cy + d.radius * Math.sin(d.angle)})`)
      .style('opacity', 0)
      .each(function (d, i) {
        d3.select(this)
          .transition()
          .delay(i * (500 / colored.length))
          .duration(180)
          .style('opacity', 1);
      })
      .each(function (d) {
        const inner = d3.select(this).append('g').attr('class', 'seat-inner');
        inner.append('circle')
          .attr('r', layout.dotR)
          .attr('fill', d.color)
          .attr('stroke', d.color)
          .attr('stroke-width', 3.5);
        if (d.avatarUrl) {
          const clipId = 'clip-' + d.userId + '-' + Math.random().toString(36).substr(2, 6);
          defs.append('clipPath')
            .attr('id', clipId)
            .append('circle')
            .attr('cx', 0)
            .attr('cy', 0)
            .attr('r', layout.dotR - 2);
          inner.append('image')
            .attr('x', -(layout.dotR - 2))
            .attr('y', -(layout.dotR - 2))
            .attr('width', (layout.dotR - 2) * 2)
            .attr('height', (layout.dotR - 2) * 2)
            .attr('preserveAspectRatio', 'xMidYMid slice')
            .attr('href', d.avatarUrl)
            .attr('clip-path', `url(#${clipId})`);
        }
      })
      .on('mouseover', function (event, d) {
        d3.select(this).select('.seat-inner')
          .transition().duration(150)
          .attr('transform', 'scale(1.8)');
        tooltip.style.opacity = 1;
        const avatarHtml = d.avatarUrl ? `<img src="${d.avatarUrl}" class="tooltip-avatar">` : '';
        tooltip.innerHTML = `
          <div class="tt-party">${d.party}</div>
          ${d.username ? `<div class="tt-user">${avatarHtml} ${d.username}</div>` : ''}
          <div class="tt-seat">Seggio ${d.seatIdx + 1} / ${d.total}</div>
        `;
      })
      .on('mousemove', event => {
        tooltip.style.left = (event.clientX + 14) + 'px';
        tooltip.style.top = (event.clientY - 36) + 'px';
      })
      .on('mouseout', function (event, d) {
        d3.select(this).select('.seat-inner')
          .transition().duration(150)
          .attr('transform', 'scale(1)');
        tooltip.style.opacity = 0;
      })
      .on('click', (event, d) => {
        if (d.userId) {
          window.open(`${window.APP_BASE || 'https://app.warera.io'}/user/${d.userId}`, '_blank');
        } else if (d.partyId && typeof openPartyModal === 'function') {
          openPartyModal(d.partyId, d.party);
        }
      });

    svg.append('text')
      .attr('x', cx).attr('y', cy - 6)
      .attr('text-anchor', 'middle')
      .attr('fill', '#535e72')
      .attr('font-size', 10)
      .attr('font-family', 'Sora, sans-serif')
      .text(`${totalSeats} seggi`);

    sorted.forEach(p => {
      const el = document.createElement('div');
      el.className = 'leg-item';
      el.title = p.name;
      el.innerHTML = `
        <span class="leg-dot" style="background:${p.color}"></span>
        <span>${p.abbr || p.name}</span>
        <span class="leg-seats">${p.seats}</span>
      `;
      legendContainer.appendChild(el);
    });

    _lastRenderData = { parties, container, legendContainer, tooltip };
  }

  return { render };
})();