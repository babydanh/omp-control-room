import './PetLoader.css';

/**
 * PetLoader: the board's big wait. Claudio, the bundled pixel chihuahua, walks back and forth above
 * the message while something takes seconds (an agent starting, a session opening). The sprite is
 * `assets/pets/claudio/pet.png` (96×96): its third row holds three 32×32 side-walking frames, shown
 * through a 32px window by sliding the row with transform. Only transform moves, so it costs nothing;
 * reduced motion shows him still.
 */
export function PetLoader({ text }: { text: string }) {
  return (
    <div role="status" data-testid="pet-loader" className="pet-loader">
      <div aria-hidden="true" className="pet-loader__track">
        <div className="pet-loader__walker">
          <div className="pet-loader__sprite">
            <div className="pet-loader__strip" style={{ backgroundImage: 'url("assets/pets/claudio/pet.png")' }} />
          </div>
        </div>
      </div>
      <p className="pet-loader__text">{text}</p>
    </div>
  );
}
