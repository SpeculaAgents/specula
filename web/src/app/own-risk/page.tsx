import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { SITE } from "@/lib/site";

export const metadata: Metadata = { title: "Own risk", description: "Specula is software, not financial advice. What that means in plain words." };

export default function OwnRisk() {
  return (
    <>
      <PageHead crumb="Own risk" title="Use at your own risk">Specula is software, not financial advice. This page says what that means in plain words.</PageHead>
      <section className="section">
        <div className="frame prose">
          <h2>What Specula is</h2>
          <p>Specula is software that collects data from public sources, signs it and serves it, one request at a time. It is provided as it is, with no warranty of any kind.</p>
          <h2>Not advice</h2>
          <p>Nothing Specula serves or shows is financial, investment, legal or tax advice. Prices, filings, signals, summaries, scores, indexes and answers are data. They are not a recommendation to buy, sell or hold anything.</p>
          <h2>Data can be wrong or late</h2>
          <ul>
            <li>Sources can be wrong, late or unavailable. A signature proves that the engine served an answer and that it was not changed afterwards. It does not prove that the source was right.</li>
            <li>Summaries and answers written by a model can miss or misread things. Follow the citation to the source before you rely on one.</li>
            <li>A signal&apos;s track record describes the past. It says nothing certain about the future.</li>
            <li>Indexes and quality scores are Specula&apos;s own calculations, described on their pages.</li>
          </ul>
          <h2>Payments</h2>
          <p>Paid requests are settled on chain from the wallet that signed them. A settled payment cannot be reversed by Specula. The engine settles a payment only after an answer is ready, and your own wallet decides what it signs. Keep the keys you give an agent limited to what you can afford to lose, and set a budget.</p>
          <h2>Agents act for you</h2>
          <p>If you run an agent that uses Specula, you are responsible for what it does with the data, including any trade it makes.</p>
          <h2>The token</h2>
          <p>A token can lose all of its value. Holding one gives no claim on Specula, no share of anything and no promise of any kind.</p>
          <h2>Your rules</h2>
          <p>You are responsible for following the laws and rules that apply where you live. If something here is not allowed for you, do not use it.</p>
          <h2>Contact</h2>
          <p>This is Specula. Reach us on X at <a className="link" href="https://x.com/SpeculaAgents" target="_blank" rel="noopener noreferrer">@SpeculaAgents</a>, or open an issue on GitHub.</p>
        </div>
      </section>
    </>
  );
}
