"use client";

import { useEffect } from "react";
import Link from "next/link";
import "./tutorial.css";

const steps = [
  ["01", "Desplegá y explorá", "Seleccioná el vehículo de reconocimiento o una escuadra. Revelá el terreno y encontrá yacimientos antes de gastar recursos."],
  ["02", "Asegurá la economía", "Construí una planta energética y luego extractores sobre minerales, petróleo y agua. Cada yacimiento muestra rendimiento y reserva."],
  ["03", "Producí una fuerza combinada", "Cuartel para infantería, fábrica para vehículos y centro de drones. Las unidades salen físicamente del edificio al terminar la cola."],
  ["04", "Leé a Nexus", "Durante movilización no hay ataques. Después, el panel Intel anticipa preparación, ofensiva y repliegue de la IA."],
  ["05", "Delegá sin perder el mando", "En Fuerzas elegí un nivel de IA y ordená defender, producir o atacar. Podés recuperar el control cuando quieras."],
  ["06", "Usá al comandante", "Desde Fuerzas podés salir de la base o elegir una inserción aérea. En terreno: WASD para mover, clic para disparar, rescate para volver."],
];

export default function TutorialPage() {
  useEffect(() => {
    document.body.classList.add("tutorial-body");
    return () => document.body.classList.remove("tutorial-body");
  }, []);

  return <main className="tutorial-page">
    <header className="tutorial-topbar"><Link href="/" className="tutorial-brand">WWIA</Link><span>GUÍA RÁPIDA // CORREDOR MINERO</span><Link href="/" className="tutorial-play">IR AL JUEGO →</Link></header>
    <section className="tutorial-hero"><div className="tutorial-eyebrow">OPERACIÓN UMBRAL // 2031</div><h1>Aprendé la operación<br /><em>en seis movimientos.</em></h1><p>Una guía corta para empezar una partida estratégica sin convertirla en un manual.</p><div className="tutorial-principles"><span><b>EXPANDÍ</b> antes de producir en masa</span><span><b>OBSERVÁ</b> antes de comprometer fuerzas</span><span><b>DELEGÁ</b> sin ceder la decisión</span></div></section>
    <section className="tutorial-steps" aria-label="Pasos del tutorial">{steps.map(([number, title, description]) => <article key={number}><div className="tutorial-number">{number}</div><h2>{title}</h2><p>{description}</p></article>)}</section>
    <section className="tutorial-controls"><div><div className="tutorial-eyebrow">CONTROLES ESENCIALES</div><h2>Como un RTS clásico; con menos fricción.</h2></div><div className="shortcut-grid"><span><kbd>CLIC</kbd> seleccionar</span><span><kbd>CLIC DER.</kbd> mover / atacar</span><span><kbd>ARRASTRAR</kbd> seleccionar grupo</span><span><kbd>TAB</kbd> vista estratégica</span><span><kbd>ESPACIO</kbd> última alerta</span><span><kbd>P</kbd> pausa táctica</span></div></section>
    <footer className="tutorial-footer"><span>Objetivo: destruir el núcleo Nexus.</span><Link href="/">INICIAR OPERACIÓN →</Link></footer>
  </main>;
}
